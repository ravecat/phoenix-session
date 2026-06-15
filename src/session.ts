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

type SessionConfig<TValue> = {
  topic: string;
  value?: TValue | null;
  connect?: ConnectConfig<TValue>;
  events?: EventReducers<TValue>;
};

type SessionActionContext = {
  call<TOk = unknown, TError = unknown>(
    event: string,
    payload: object,
    timeout?: number,
  ): ActionCall<TOk, TError>;
  cast(event: string, payload: object): void;
};

type Session<TValue> = SessionStore<TValue, NoActions> & {
  extend<TExtension extends object>(
    defineExtension: (session: SessionActionContext) => TExtension,
  ): SessionStore<TValue, ExtensionActionsOf<TExtension>> & TExtension;
};

export function session<TValue = unknown>(
  socket: Pick<Socket, "channel">,
  config: SessionConfig<TValue>,
): Session<TValue> {
  let channel: Channel | null = null;
  let activeActionName: string | null = null;
  let nextActionRunId = 0;
  const activeActionRunIds = new Map<string, number>();

  const initialState: SessionState<TValue, RuntimeActions> = {
    value: config.value ?? null,
    status: "loading",
    error: null,
    processing: {},
    errors: {},
    timeouts: {},
  };

  let currentState = initialState;
  const $state = atom<SessionState<TValue, RuntimeActions>>(initialState);

  const update = (
    reduce: (current: SessionState<TValue, RuntimeActions>) => SessionState<TValue, RuntimeActions>,
  ) => {
    currentState = reduce(currentState);
    $state.set(currentState);
  };

  const registerAction = (action: string) => {
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

  onMount($state, () => {
    channel = socket.channel(config.topic, {});
    const cleanups: Array<() => void> = [];

    const errorRef = channel.onError((reason) => {
      update((current) => ({
        ...current,
        status: disconnectStatus(current),
        error: { kind: "transport_error", cause: reason },
      }));
    });
    cleanups.push(() => channel?.off(CHANNEL_ERROR_EVENT, errorRef));

    const closeRef = channel.onClose(() => {
      update((current) => ({
        ...current,
        status: disconnectStatus(current),
        error: { kind: "transport_close" },
      }));
    });

    cleanups.push(() => channel?.off(CHANNEL_CLOSE_EVENT, closeRef));

    for (const [event, reducer] of Object.entries(config.events ?? {})) {
      const ref = channel.on(event, (payload) => {
        update((current) => ({
          ...current,
          value: reducer(current.value, payload),
          status: "ready",
          error: null,
        }));
      });
      cleanups.push(() => channel?.off(event, ref));
    }

    channel
      .join()
      .receive("ok", (response: unknown) => {
        update((current) => ({
          ...current,
          value: config.connect?.ok ? config.connect.ok(current.value, response) : current.value,
          status: "ready",
          error: null,
        }));
      })
      .receive("error", (response: unknown) => {
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
        update((current) => ({
          ...current,
          status: "failed",
          error: {
            kind: "connect_timeout",
            cause: config.connect?.timeout?.(),
          },
        }));
      });

    return () => {
      for (const cleanup of cleanups) cleanup();
      channel?.leave();
      channel = null;
    };
  });

  const subscribe = <TActions extends Record<string, unknown>>(
    listener: (value: SessionState<TValue, TActions>) => void,
  ) => $state.subscribe(listener as (value: SessionState<TValue, RuntimeActions>) => void);

  const sessionStore: SessionStore<TValue, NoActions> = {
    subscribe: (listener) => subscribe<NoActions>(listener),
  };

  const actionContext: SessionActionContext = {
    call: <TOk = unknown, TError = unknown>(event: string, payload: object, timeout?: number) => {
      if (!channel) {
        throw new Error(`Cannot call "${event}" before joining "${config.topic}"`);
      }

      const call = channel.push(event, payload, timeout) as ActionCall<TOk, TError>;
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
      if (!channel) {
        throw new Error(`Cannot cast "${event}" before joining "${config.topic}"`);
      }

      channel.push(event, payload);
    },
  };

  const extend = <TExtension extends object>(
    defineExtension: (session: SessionActionContext) => TExtension,
  ): SessionStore<TValue, ExtensionActionsOf<TExtension>> & TExtension => {
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

    return {
      ...(wrappedExtension as typeof extension),
      subscribe: (listener) => subscribe<ExtensionActionsOf<TExtension>>(listener),
    };
  };

  return {
    ...sessionStore,
    extend,
  };
}
