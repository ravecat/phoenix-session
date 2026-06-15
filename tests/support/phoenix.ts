import type {
  MessageRef,
  Channel as PhoenixChannel,
  Push as PhoenixPush,
  Socket as PhoenixSocket,
  PushStatus,
  SocketConnectOption,
} from "phoenix";
import { vi } from "vitest";

type MockConstructor<TArgs extends readonly unknown[], TInstance> = {
  new (...args: TArgs): TInstance;
};

type PushCallback = Parameters<PhoenixPush["receive"]>[1];
type ChannelCallback = Parameters<PhoenixChannel["on"]>[1];
type ChannelErrorCallback = Parameters<PhoenixChannel["onError"]>[0];
type ChannelCloseCallback = Parameters<PhoenixChannel["onClose"]>[0];

export type MockPush = PhoenixPush & {
  mockChannel: PhoenixChannel;
  mockEvent: string;
  mockPayload: object;
  mockTimeout: number;
  mockReply(status: PushStatus, response?: unknown): void;
};

export type MockChannel = PhoenixChannel & {
  params?: object | (() => object);
  socket?: PhoenixSocket;
  mockJoinPush: MockPush;
  mockPushes: MockPush[];
  mockReceive(event: string, payload?: unknown): void;
  mockError(reason?: unknown): void;
  mockClose(): void;
};

export type MockSocket = PhoenixSocket & {
  mockEndpoint: string;
  mockOptions?: Partial<SocketConnectOption>;
  mockChannels: MockChannel[];
};

export const Push = vi.fn(
  class {
    mockChannel: PhoenixChannel;
    mockEvent: string;
    mockPayload: object;
    mockTimeout: number;

    private callbacks = new Map<PushStatus, PushCallback>();

    constructor(channel: PhoenixChannel, event: string, payload: object, timeout = 10_000) {
      this.mockChannel = channel;
      this.mockEvent = event;
      this.mockPayload = payload;
      this.mockTimeout = timeout;
    }

    send = vi.fn<PhoenixPush["send"]>();
    resend = vi.fn<PhoenixPush["resend"]>((nextTimeout) => {
      this.mockTimeout = nextTimeout;
    });
    receive = vi.fn<MockPush["receive"]>((status, callback) => {
      this.callbacks.set(status, callback);
      return this as unknown as MockPush;
    });

    mockReply = (status: PushStatus, response?: unknown) => {
      this.callbacks.get(status)?.(response);
    };
  },
) as unknown as MockConstructor<
  [channel: PhoenixChannel, event: string, payload: object, timeout?: number],
  MockPush
>;

export const Channel = vi.fn(
  class {
    topic: string;
    params?: object | (() => object);
    socket?: PhoenixSocket;
    state: PhoenixChannel["state"] = "closed";
    mockJoinPush: MockPush;
    mockPushes: MockPush[] = [];

    private nextRef = 0;
    private callbacks = new Map<string, Map<number, ChannelCallback>>();
    private errorCallbacks = new Map<number, ChannelErrorCallback>();
    private closeCallbacks = new Map<number, ChannelCloseCallback>();

    constructor(topic: string, params?: object | (() => object), socket?: PhoenixSocket) {
      this.topic = topic;
      this.params = params;
      this.socket = socket;
      this.mockJoinPush = new Push(this as unknown as PhoenixChannel, "phx_join", {});
    }

    join = vi.fn<PhoenixChannel["join"]>((timeout = 10_000) => {
      this.mockJoinPush.mockTimeout = timeout;
      return this.mockJoinPush;
    });
    leave = vi.fn<PhoenixChannel["leave"]>(
      (timeout = 10_000) => new Push(this as unknown as PhoenixChannel, "phx_leave", {}, timeout),
    );
    push = vi.fn<PhoenixChannel["push"]>((event, payload, timeout = 10_000) => {
      const push = new Push(this as unknown as PhoenixChannel, event, payload, timeout);
      this.mockPushes.push(push);
      return push;
    });
    on = vi.fn<PhoenixChannel["on"]>((event, callback) => {
      const ref = ++this.nextRef;
      const eventCallbacks = this.callbacks.get(event) ?? new Map<number, ChannelCallback>();
      eventCallbacks.set(ref, callback);
      this.callbacks.set(event, eventCallbacks);
      return ref;
    });
    off = vi.fn<PhoenixChannel["off"]>((event, ref) => {
      if (event === "phx_error") {
        if (ref == null) {
          this.errorCallbacks.clear();
        } else {
          this.errorCallbacks.delete(ref);
        }
        return;
      }

      if (event === "phx_close") {
        if (ref == null) {
          this.closeCallbacks.clear();
        } else {
          this.closeCallbacks.delete(ref);
        }
        return;
      }

      if (ref == null) {
        this.callbacks.delete(event);
        return;
      }

      this.callbacks.get(event)?.delete(ref);
    });
    onClose = vi.fn<PhoenixChannel["onClose"]>((callback) => {
      const ref = ++this.nextRef;
      this.closeCallbacks.set(ref, callback);
      return ref;
    });
    onError = vi.fn<PhoenixChannel["onError"]>((callback) => {
      const ref = ++this.nextRef;
      this.errorCallbacks.set(ref, callback);
      return ref;
    });
    onMessage = vi.fn<PhoenixChannel["onMessage"]>((event, payload) => {
      this.mockReceive(event, payload);
      return payload;
    });

    mockReceive = (event: string, payload?: unknown) => {
      for (const callback of this.callbacks.get(event)?.values() ?? []) {
        callback(payload);
      }
    };

    mockError = (reason?: unknown) => {
      for (const callback of this.errorCallbacks.values()) {
        callback(reason);
      }
    };

    mockClose = () => {
      for (const callback of this.closeCallbacks.values()) {
        callback(undefined, undefined, undefined);
      }
    };
  },
) as unknown as MockConstructor<
  [topic: string, params?: object | (() => object), socket?: PhoenixSocket],
  MockChannel
>;

export const Socket = vi.fn(
  class {
    mockEndpoint: string;
    mockOptions?: Partial<SocketConnectOption>;
    mockChannels: MockChannel[] = [];

    private nextRef = 0;

    constructor(endpoint: string, options?: Partial<SocketConnectOption>) {
      this.mockEndpoint = endpoint;
      this.mockOptions = options;
    }

    protocol = vi.fn<PhoenixSocket["protocol"]>(() => "ws");
    endPointURL = vi.fn<PhoenixSocket["endPointURL"]>(() => this.mockEndpoint);
    connect = vi.fn<PhoenixSocket["connect"]>();
    disconnect = vi.fn<PhoenixSocket["disconnect"]>();
    connectionState = vi.fn<PhoenixSocket["connectionState"]>(() => "open");
    isConnected = vi.fn<PhoenixSocket["isConnected"]>(() => true);
    replaceTransport = vi.fn<PhoenixSocket["replaceTransport"]>();
    remove = vi.fn<PhoenixSocket["remove"]>();
    channel = vi.fn<PhoenixSocket["channel"]>((topic, params) => {
      const channel = new Channel(topic, params, this as unknown as PhoenixSocket);
      this.mockChannels.push(channel);
      return channel;
    });
    push = vi.fn<PhoenixSocket["push"]>();
    log = vi.fn<PhoenixSocket["log"]>();
    hasLogger = vi.fn<PhoenixSocket["hasLogger"]>(() => false);
    onOpen = vi.fn<PhoenixSocket["onOpen"]>(() => this.makeRef());
    onClose = vi.fn<PhoenixSocket["onClose"]>(() => this.makeRef());
    onError = vi.fn<PhoenixSocket["onError"]>(() => this.makeRef());
    onMessage = vi.fn<PhoenixSocket["onMessage"]>(() => this.makeRef());
    makeRef = vi.fn<PhoenixSocket["makeRef"]>(() => String(++this.nextRef) as MessageRef);
    off = vi.fn<PhoenixSocket["off"]>();
    ping = vi.fn<PhoenixSocket["ping"]>(() => true);
  },
) as unknown as MockConstructor<
  [endpoint: string, options?: Partial<SocketConnectOption>],
  MockSocket
>;
