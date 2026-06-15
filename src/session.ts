import { atom, onMount } from "nanostores";
import type { Channel, Push, Socket } from "phoenix";

const CHANNEL_CLOSE_EVENT = "phx_close";
const CHANNEL_ERROR_EVENT = "phx_error";

type SessionStatus = "loading" | "ready" | "stale" | "failed";

type SessionError =
  | { kind: "connect_error"; cause: unknown }
  | { kind: "connect_timeout"; cause?: unknown }
  | { kind: "transport_error"; cause: unknown }
  | { kind: "transport_close" };

type NoActions = Record<never, never>;

type RuntimeActions = Record<string, unknown>;

type ActionCall<TOk = unknown, TError = unknown> = Omit<Push, "receive"> & {
  receive(status: "ok", callback: (response: TOk) => unknown): ActionCall<TOk, TError>;
  receive(status: "error", callback: (response: TError) => unknown): ActionCall<TOk, TError>;
  receive(status: "timeout", callback: () => unknown): ActionCall<TOk, TError>;
};

type ChannelHandler<TArgs extends unknown[], TResult> = {
  handle(...args: TArgs): TResult;
}["handle"];

type ConnectConfig<TValue> = {
  ok?: ChannelHandler<[Readonly<TValue> | null, unknown], TValue>;
  error?: ChannelHandler<[unknown], unknown>;
  timeout?: () => unknown;
};

type EventReducers<TValue> = Record<
  string,
  ChannelHandler<[Readonly<TValue> | null, unknown], TValue>
>;

type ExtensionActionNameOf<TExtension extends object> = {
  [K in keyof TExtension]: TExtension[K] extends (...args: never[]) => unknown ? K : never;
}[keyof TExtension];

type ExtensionActionsOf<TExtension extends object> = {
  readonly [K in Extract<ExtensionActionNameOf<TExtension>, string>]: ActionErrorOf<TExtension[K]>;
};

type ActionErrorOf<TAction> = TAction extends (
  ...args: never[]
) => ActionCall<infer _TOk, infer TError>
  ? TError
  : unknown;

type ActionProcessing<TActions extends Record<string, unknown>> = {
  readonly [K in keyof TActions]: boolean;
};

type ActionErrors<TActions extends Record<string, unknown>> = {
  readonly [K in keyof TActions]: TActions[K] | null;
};

type ActionTimeouts<TActions extends Record<string, unknown>> = {
  readonly [K in keyof TActions]: boolean;
};

type SessionState<TValue, TActions extends Record<string, unknown>> = {
  readonly value: TValue | null;
  readonly status: SessionStatus;
  readonly error: SessionError | null;
  readonly processing: ActionProcessing<TActions>;
  readonly errors: ActionErrors<TActions>;
  readonly timeouts: ActionTimeouts<TActions>;
};

type ReadableStore<TState> = {
  subscribe(listener: (state: TState) => void): () => void;
};

type SessionStore<TValue, TActions extends Record<string, unknown>> = ReadableStore<
  SessionState<TValue, TActions>
>;

type SessionOptions<TValue> = {
  value?: TValue | null;
  connect?: ConnectConfig<TValue>;
  events?: EventReducers<TValue>;
};

type SessionConfig<TValue> = SessionOptions<TValue> & {
  topic: string;
};

type SessionAttachConfig = {
  topic: string;
};

type SessionActionContext = {
  call<TOk = unknown, TError = unknown>(
    event: string,
    payload: object,
    timeout?: number,
  ): ActionCall<TOk, TError>;
  cast(event: string, payload: object): void;
};

type Session<
  TValue,
  TActions extends Record<string, unknown> = NoActions,
  TExtensionState extends object = Record<never, never>,
> = SessionStore<TValue, TActions> &
  TExtensionState & {
    attach(socket: Socket, config: SessionAttachConfig): void;
    detach(): void;
    extend<TExtension extends object>(
      defineExtension: (session: SessionActionContext) => TExtension,
    ): Session<TValue, TActions & ExtensionActionsOf<TExtension>, TExtensionState & TExtension>;
  };

export function session<TValue = unknown>(config?: SessionOptions<TValue>): Session<TValue>;
export function session<TValue = unknown>(
  socket: Socket,
  config: SessionConfig<TValue>,
): Session<TValue>;
export function session<TValue = unknown>(
  socketOrConfig: Socket | SessionOptions<TValue> = {},
  attachedConfig?: SessionConfig<TValue>,
): Session<TValue> {
  const config = (attachedConfig ?? socketOrConfig) as SessionOptions<TValue>;
  let channel: Channel | null = null;
  let attachment: { socket: Socket; topic: string } | null = attachedConfig
    ? { socket: socketOrConfig as Socket, topic: attachedConfig.topic }
    : null;
  let mounted = false;
  let stopCurrentChannel = () => {};
  let activeActionName: string | null = null;
  let nextActionRunId = 0;
  let nextChannelRunId = 0;
  const activeActionRunIds = new Map<string, number>();
  const actionNames = new Set<string>();

  const createInitialState = (): SessionState<TValue, RuntimeActions> => {
    let processing: Record<string, boolean> = {};
    let errors: Record<string, unknown | null> = {};
    let timeouts: Record<string, boolean> = {};

    for (const action of actionNames) {
      processing = { ...processing, [action]: false };
      errors = { ...errors, [action]: null };
      timeouts = { ...timeouts, [action]: false };
    }

    return {
      value: config.value ?? null,
      status: "loading",
      error: null,
      processing,
      errors,
      timeouts,
    };
  };

  let currentState = createInitialState();
  const $state = atom<SessionState<TValue, RuntimeActions>>(currentState);

  const update = (
    reduce: (current: SessionState<TValue, RuntimeActions>) => SessionState<TValue, RuntimeActions>,
  ) => {
    currentState = reduce(currentState);
    $state.set(currentState);
  };

  const reset = () => {
    activeActionName = null;
    activeActionRunIds.clear();
    currentState = createInitialState();
    $state.set(currentState);
  };

  const registerAction = (action: string) => {
    actionNames.add(action);
    update((current) => {
      if (action in current.processing && action in current.errors && action in current.timeouts) {
        return current;
      }

      return {
        ...current,
        processing: { ...current.processing, [action]: false },
        errors: { ...current.errors, [action]: null },
        timeouts: { ...current.timeouts, [action]: false },
      };
    });
  };

  const disconnectStatus = (current: SessionState<TValue, RuntimeActions>): SessionStatus => {
    return current.status === "ready" || current.status === "stale" ? "stale" : "failed";
  };

  const assertChannel = (event: string, operation: "call" | "cast") => {
    if (channel) {
      return channel;
    }

    if (attachment) {
      throw new Error(`Cannot ${operation} "${event}" before joining "${attachment.topic}"`);
    }

    throw new Error(`Cannot ${operation} "${event}" before attaching a session`);
  };

  const runAction = <TResult>(action: string, run: () => TResult) => {
    const previousActionName = activeActionName;
    activeActionName = action;

    try {
      return run();
    } finally {
      activeActionName = previousActionName;
    }
  };

  const startCall = (action: string) => {
    const runId = ++nextActionRunId;
    activeActionRunIds.set(action, runId);
    update((current) => ({
      ...current,
      processing: { ...current.processing, [action]: true },
      errors: { ...current.errors, [action]: null },
      timeouts: { ...current.timeouts, [action]: false },
    }));
    return runId;
  };

  const resolveCall = (
    action: string,
    runId: number,
    result: Pick<SessionState<TValue, RuntimeActions>, "processing" | "errors" | "timeouts">,
  ) => {
    if (activeActionRunIds.get(action) !== runId) {
      return;
    }

    activeActionRunIds.delete(action);
    update((current) => ({
      ...current,
      ...result,
    }));
  };

  const startChannel = () => {
    if (!mounted || !attachment) {
      return;
    }

    stopCurrentChannel();

    const channelRunId = ++nextChannelRunId;
    const activeAttachment = attachment;
    const activeChannel = activeAttachment.socket.channel(activeAttachment.topic, {});
    const cleanups: Array<() => void> = [];
    channel = activeChannel;

    const isCurrentChannel = () => channel === activeChannel && channelRunId === nextChannelRunId;

    const errorRef = activeChannel.onError((reason) => {
      if (!isCurrentChannel()) {
        return;
      }

      update((current) => ({
        ...current,
        status: disconnectStatus(current),
        error: { kind: "transport_error", cause: reason },
      }));
    });
    cleanups.push(() => activeChannel.off(CHANNEL_ERROR_EVENT, errorRef));

    const closeRef = activeChannel.onClose(() => {
      if (!isCurrentChannel()) {
        return;
      }

      update((current) => ({
        ...current,
        status: disconnectStatus(current),
        error: { kind: "transport_close" },
      }));
    });

    cleanups.push(() => activeChannel.off(CHANNEL_CLOSE_EVENT, closeRef));

    for (const [event, reducer] of Object.entries(config.events ?? {})) {
      const ref = activeChannel.on(event, (payload) => {
        if (!isCurrentChannel()) {
          return;
        }

        update((current) => ({
          ...current,
          value: reducer(current.value, payload),
          status: "ready",
          error: null,
        }));
      });
      cleanups.push(() => activeChannel.off(event, ref));
    }

    activeChannel
      .join()
      .receive("ok", (response: unknown) => {
        if (!isCurrentChannel()) {
          return;
        }

        update((current) => ({
          ...current,
          value: config.connect?.ok ? config.connect.ok(current.value, response) : current.value,
          status: "ready",
          error: null,
        }));
      })
      .receive("error", (response: unknown) => {
        if (!isCurrentChannel()) {
          return;
        }

        update((current) => ({
          ...current,
          status: "failed",
          error: {
            kind: "connect_error",
            cause: config.connect?.error ? config.connect.error(response) : response,
          },
        }));
      })
      .receive("timeout", () => {
        if (!isCurrentChannel()) {
          return;
        }

        update((current) => ({
          ...current,
          status: "failed",
          error: {
            kind: "connect_timeout",
            cause: config.connect?.timeout?.(),
          },
        }));
      });

    stopCurrentChannel = () => {
      nextChannelRunId += 1;

      for (const cleanup of cleanups) cleanup();
      activeChannel.leave();
      cleanups.length = 0;

      if (channel === activeChannel) {
        channel = null;
      }
    };
  };

  onMount($state, () => {
    mounted = true;
    startChannel();

    return () => {
      mounted = false;
      stopCurrentChannel();
      stopCurrentChannel = () => {};
    };
  });

  const subscribe = <TActions extends Record<string, unknown>>(
    listener: (value: SessionState<TValue, TActions>) => void,
  ) => $state.subscribe(listener as (value: SessionState<TValue, RuntimeActions>) => void);

  const actionContext: SessionActionContext = {
    call: <TOk = unknown, TError = unknown>(event: string, payload: object, timeout?: number) => {
      const call = assertChannel(event, "call").push(event, payload, timeout) as ActionCall<
        TOk,
        TError
      >;
      const action = activeActionName ?? event;
      const runId = startCall(action);

      call
        .receive("ok", () => {
          resolveCall(action, runId, {
            processing: { ...currentState.processing, [action]: false },
            errors: { ...currentState.errors, [action]: null },
            timeouts: { ...currentState.timeouts, [action]: false },
          });
        })
        .receive("error", (response) => {
          resolveCall(action, runId, {
            processing: { ...currentState.processing, [action]: false },
            errors: { ...currentState.errors, [action]: response ?? null },
            timeouts: { ...currentState.timeouts, [action]: false },
          });
        })
        .receive("timeout", () => {
          resolveCall(action, runId, {
            processing: { ...currentState.processing, [action]: false },
            errors: { ...currentState.errors, [action]: null },
            timeouts: { ...currentState.timeouts, [action]: true },
          });
        });

      return call;
    },
    cast: (event: string, payload: object) => {
      assertChannel(event, "cast").push(event, payload);
    },
  };

  const attach = (socket: Socket, attachConfig: SessionAttachConfig) => {
    if (attachment?.socket === socket && attachment.topic === attachConfig.topic) {
      return;
    }

    stopCurrentChannel();
    stopCurrentChannel = () => {};
    attachment = {
      socket,
      topic: attachConfig.topic,
    };
    reset();
    startChannel();
  };

  const detach = () => {
    attachment = null;
    stopCurrentChannel();
    stopCurrentChannel = () => {};
    reset();
  };

  const createSessionObject = <
    TActions extends Record<string, unknown>,
    TExtensionState extends object,
  >(
    extensionState: TExtensionState,
  ): Session<TValue, TActions, TExtensionState> =>
    ({
      ...extensionState,
      subscribe: (listener) => subscribe<TActions>(listener),
      attach,
      detach,
      extend<TExtension extends object>(
        defineExtension: (session: SessionActionContext) => TExtension,
      ) {
        const extension = defineExtension(actionContext);
        const wrappedExtension = { ...extension } as Record<string, unknown>;

        for (const [action, value] of Object.entries(extension)) {
          if (typeof value !== "function") {
            continue;
          }

          registerAction(action);

          wrappedExtension[action] = function (this: unknown, ...args: unknown[]) {
            return runAction(action, () => value.apply(this, args));
          };
        }

        return createSessionObject<
          TActions & ExtensionActionsOf<TExtension>,
          TExtensionState & TExtension
        >({
          ...extensionState,
          ...(wrappedExtension as TExtension),
        });
      },
    }) as Session<TValue, TActions, TExtensionState>;

  return createSessionObject<NoActions, Record<never, never>>({});
}
