import { describe, expect, it, vi } from "vitest";
import { session as createSession } from "../src";
import type { MockPush, MockSocket } from "./support/phoenix";
import { Socket } from "./support/phoenix";

type StoreStateOf<TStore> = TStore extends {
  subscribe(listener: (value: infer TValue) => void): () => void;
}
  ? TValue
  : never;

type TestValue = {
  count: number;
};

const testSession = (
  config: Parameters<typeof createSession<TestValue>>[1] = {
    topic: "counter:lobby",
  },
) => {
  const socket = new Socket("/socket") as MockSocket;
  const store = createSession<TestValue>(socket, config).extend(({ call }) => ({
    start() {
      return call("server_start", {});
    },
    save(payload: { id: string }) {
      return call("server_save", payload);
    },
  }));
  let state: StoreStateOf<typeof store> | undefined;
  const unsubscribe = store.subscribe((nextState) => {
    state = nextState;
  });
  const channel = socket.mockChannels[0];

  return {
    channel,
    store,
    get state() {
      if (state === undefined) {
        throw new Error("Expected test session to be subscribed");
      }

      return state;
    },
    unsubscribe,
  };
};

describe("attachable session lifecycle", () => {
  it("should expose initial loading state before attach", () => {
    const store = createSession<TestValue>({
      value: { count: 1 },
    });
    let state: StoreStateOf<typeof store> | undefined;
    const unsubscribe = store.subscribe((nextState) => {
      state = nextState;
    });

    expect(state).toEqual({
      value: { count: 1 },
      status: "loading",
      error: null,
      processing: {},
      errors: {},
      timeouts: {},
    });

    unsubscribe();
  });

  it("should keep attach lazy until the session store is mounted", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>();

    store.attach(socket, { topic: "counter:lobby" });

    expect(socket.mockChannels).toHaveLength(0);

    const unsubscribe = store.subscribe(() => {});

    expect(socket.mockChannels).toHaveLength(1);
    expect(socket.mockChannels[0]?.topic).toBe("counter:lobby");

    unsubscribe();
  });

  it("should attach after subscription and join the channel", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>();
    const unsubscribe = store.subscribe(() => {});

    expect(socket.mockChannels).toHaveLength(0);

    store.attach(socket, { topic: "counter:lobby" });

    expect(socket.mockChannels).toHaveLength(1);
    expect(socket.mockChannels[0]?.join).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("should detach and reset to loading state with action buckets", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>({
      value: { count: 1 },
    }).extend(({ call }) => ({
      start() {
        return call("server_start", {});
      },
    }));
    let state: StoreStateOf<typeof store> | undefined;
    const unsubscribe = store.subscribe((nextState) => {
      state = nextState;
    });

    store.attach(socket, { topic: "counter:lobby" });
    const channel = socket.mockChannels[0];
    channel?.mockJoinPush.mockReply("ok");

    expect(state).toMatchObject({
      status: "ready",
    });

    store.detach();

    expect(channel?.leave).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      value: { count: 1 },
      status: "loading",
      error: null,
      processing: { start: false },
      errors: { start: null },
      timeouts: { start: false },
    });

    unsubscribe();
  });

  it("should no-op when attaching the same socket and topic", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>(socket, {
      topic: "counter:lobby",
      value: { count: 1 },
    });
    const unsubscribe = store.subscribe(() => {});
    const channel = socket.mockChannels[0];
    channel?.mockJoinPush.mockReply("ok");

    store.attach(socket, { topic: "counter:lobby" });

    expect(socket.mockChannels).toHaveLength(1);
    expect(channel?.leave).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("should reattach and reset state when the topic changes", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>(socket, {
      topic: "counter:lobby",
      value: { count: 1 },
      connect: {
        ok: (_value, reply: TestValue) => reply,
      },
    }).extend(({ call }) => ({
      start() {
        return call("server_start", {});
      },
    }));
    let state: StoreStateOf<typeof store> | undefined;
    const unsubscribe = store.subscribe((nextState) => {
      state = nextState;
    });
    const firstChannel = socket.mockChannels[0];
    firstChannel?.mockJoinPush.mockReply("ok", { count: 9 });

    expect(state).toMatchObject({
      value: { count: 9 },
      status: "ready",
    });

    store.attach(socket, { topic: "counter:other" });

    expect(firstChannel?.leave).toHaveBeenCalledTimes(1);
    expect(socket.mockChannels).toHaveLength(2);
    expect(socket.mockChannels[1]?.topic).toBe("counter:other");
    expect(state).toEqual({
      value: { count: 1 },
      status: "loading",
      error: null,
      processing: { start: false },
      errors: { start: null },
      timeouts: { start: false },
    });

    unsubscribe();
  });

  it("should expose lifecycle methods on extended sessions", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>().extend(({ call }) => ({
      start() {
        return call("server_start", {});
      },
    }));
    const unsubscribe = store.subscribe(() => {});

    store.attach(socket, { topic: "counter:lobby" });

    expect(socket.mockChannels).toHaveLength(1);

    store.detach();

    expect(socket.mockChannels[0]?.leave).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe("session lifecycle", () => {
  it("should start loading without an initial value", () => {
    const subject = testSession();

    expect(subject.state).toEqual({
      value: null,
      status: "loading",
      error: null,
      processing: {
        start: false,
        save: false,
      },
      errors: {
        start: null,
        save: null,
      },
      timeouts: {
        start: false,
        save: false,
      },
    });
  });

  it("should start loading with an initial value", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    });

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "loading",
      error: null,
    });
  });

  it("should join the configured topic on mount", () => {
    const subject = testSession({
      topic: "counter:lobby",
    });

    expect(subject.channel.topic).toBe("counter:lobby");
    expect(subject.channel.params).toEqual({});
  });

  it("should keep current value on join ok by default", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    });

    subject.channel.mockJoinPush.mockReply("ok", { count: 2 });

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "ready",
      error: null,
    });
  });

  it("should normalize join ok response through connect.ok", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
      connect: {
        ok: (value, reply: TestValue) => ({ count: (value?.count ?? 0) + reply.count }),
      },
    });

    subject.channel.mockJoinPush.mockReply("ok", { count: 2 });

    expect(subject.state).toMatchObject({
      value: { count: 3 },
      status: "ready",
      error: null,
    });
  });

  it("should map join errors through connect.error", () => {
    const subject = testSession({
      topic: "counter:lobby",
      connect: {
        error: (reply: { reason?: string }) => reply.reason ?? "join_failed",
      },
    });

    subject.channel.mockJoinPush.mockReply("error", { reason: "unauthorized" });

    expect(subject.state).toMatchObject({
      status: "failed",
      error: { kind: "connect_error", cause: "unauthorized" },
    });
  });

  it("should map join timeout through connect.timeout", () => {
    const subject = testSession({
      topic: "counter:lobby",
      connect: {
        timeout: () => "join_timeout",
      },
    });

    subject.channel.mockJoinPush.mockReply("timeout");

    expect(subject.state).toMatchObject({
      status: "failed",
      error: { kind: "connect_timeout", cause: "join_timeout" },
    });
  });

  it("should mark empty sessions failed on transport error", () => {
    const subject = testSession();
    const cause = { reason: "transport_down" };

    subject.channel.mockError(cause);

    expect(subject.state).toMatchObject({
      value: null,
      status: "failed",
      error: { kind: "transport_error", cause },
    });
  });

  it("should mark valued sessions failed on transport error before join ok", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    });
    const cause = { reason: "transport_down" };

    subject.channel.mockError(cause);

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "failed",
      error: { kind: "transport_error", cause },
    });
  });

  it("should mark connected sessions stale on transport error", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    });
    const cause = { reason: "transport_down" };

    subject.channel.mockJoinPush.mockReply("ok");
    subject.channel.mockError(cause);

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "stale",
      error: { kind: "transport_error", cause },
    });
  });

  it("should mark empty sessions failed on channel close", () => {
    const subject = testSession();

    subject.channel.mockClose();

    expect(subject.state).toMatchObject({
      value: null,
      status: "failed",
      error: { kind: "transport_close" },
    });
  });

  it("should mark valued sessions failed on channel close before join ok", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    });

    subject.channel.mockClose();

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "failed",
      error: { kind: "transport_close" },
    });
  });

  it("should mark connected sessions stale on channel close", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
    });

    subject.channel.mockJoinPush.mockReply("ok");
    subject.channel.mockClose();

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "stale",
      error: { kind: "transport_close" },
    });
  });

  it("should run configured event reducers with current value and payload", () => {
    const subject = testSession({
      topic: "counter:lobby",
      value: { count: 1 },
      events: {
        increment: (value, payload: { by: number }) => ({
          count: (value?.count ?? 0) + payload.by,
        }),
      },
    });

    subject.channel.mockReceive("increment", { by: 2 });
    subject.channel.mockReceive("increment", { by: 3 });

    expect(subject.state).toMatchObject({
      value: { count: 6 },
      status: "ready",
      error: null,
    });
  });

  it("should clear session-level error after a configured event", () => {
    const subject = testSession({
      topic: "counter:lobby",
      events: {
        increment: (value, payload: { by: number }) => ({
          count: (value?.count ?? 0) + payload.by,
        }),
      },
    });

    subject.channel.mockError({ reason: "down" });
    subject.channel.mockReceive("increment", { by: 1 });

    expect(subject.state).toMatchObject({
      value: { count: 1 },
      status: "ready",
      error: null,
    });
  });

  it("should remove handlers and leave channel on unsubscribe", () => {
    vi.useFakeTimers();
    const subject = testSession({
      topic: "counter:lobby",
      events: {
        increment: (value, payload: { by: number }) => ({
          count: (value?.count ?? 0) + payload.by,
        }),
      },
    });

    subject.unsubscribe();
    vi.advanceTimersByTime(1000);

    expect(subject.channel.off).toHaveBeenCalledWith("phx_error", expect.any(Number));
    expect(subject.channel.off).toHaveBeenCalledWith("phx_close", expect.any(Number));
    expect(subject.channel.off).toHaveBeenCalledWith("increment", expect.any(Number));
    expect(subject.channel.leave).toHaveBeenCalledTimes(1);
    expect(() => subject.store.start()).toThrow(
      'Cannot call "server_start" before joining "counter:lobby"',
    );

    vi.useRealTimers();
  });
});

describe("session actions", () => {
  it("should register buckets for extension function keys", () => {
    const subject = testSession();

    expect(subject.state.processing).toEqual({
      start: false,
      save: false,
    });
    expect(subject.state.errors).toEqual({
      start: null,
      save: null,
    });
    expect(subject.state.timeouts).toEqual({
      start: false,
      save: false,
    });
  });

  it("should not register buckets for non-function extension values", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>(socket, {
      topic: "counter:lobby",
    }).extend(({ call }) => ({
      label: "Actions",
      start() {
        return call("server_start", {});
      },
      save(payload: { id: string }) {
        return call("server_save", payload);
      },
    }));
    let state: StoreStateOf<typeof store> | undefined;
    store.subscribe((nextState) => {
      state = nextState;
    });

    if (state === undefined) {
      throw new Error("Expected test session to be subscribed");
    }

    expect(store.label).toBe("Actions");
    expect("label" in state.processing).toBe(false);
  });

  it("should track extension calls by public method name", () => {
    const subject = testSession();

    const call = subject.store.start() as MockPush;

    expect(call.mockEvent).toBe("server_start");
    expect(subject.state.processing.start).toBe(true);
    expect("server_start" in subject.state.processing).toBe(false);

    call.mockReply("ok");

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.errors.start).toBeNull();
    expect(subject.state.timeouts.start).toBe(false);
  });

  it("should not expose action context methods on the base session", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>(socket, {
      topic: "actions:lobby",
      value: { count: 0 },
    });

    expect("call" in store).toBe(false);
    expect("cast" in store).toBe(false);
    expect("push" in store).toBe(false);
  });

  it("should throw when an extended action calls before the channel is mounted", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>(socket, {
      topic: "counter:lobby",
    }).extend(({ call }) => ({
      start() {
        return call("server_start", {});
      },
      save(payload: { id: string }) {
        return call("server_save", payload);
      },
    }));

    expect(socket.mockChannels).toHaveLength(0);
    expect(() => store.start()).toThrow(
      'Cannot call "server_start" before joining "counter:lobby"',
    );
  });

  it("should set processing true and clear previous errors/timeouts when a call starts", () => {
    const subject = testSession();

    const firstCall = subject.store.start() as MockPush;
    firstCall.mockReply("error", { reason: "blocked" });
    subject.store.start();

    expect(subject.state.processing.start).toBe(true);
    expect(subject.state.errors.start).toBeNull();
    expect(subject.state.timeouts.start).toBe(false);
  });

  it("should store error replies on error", () => {
    const subject = testSession();

    const call = subject.store.start() as MockPush;
    call.mockReply("error", { reason: "blocked" });

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.errors.start).toEqual({ reason: "blocked" });
    expect(subject.state.timeouts.start).toBe(false);
  });

  it("should store null for nullish error replies", () => {
    const subject = testSession();

    const call = subject.store.start() as MockPush;
    call.mockReply("error");

    expect(subject.state.errors.start).toBeNull();
  });

  it("should store timeout true on timeout", () => {
    const subject = testSession();

    const call = subject.store.start() as MockPush;
    call.mockReply("timeout");

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.errors.start).toBeNull();
    expect(subject.state.timeouts.start).toBe(true);
  });

  it("should clear previous error and timeout on retry", () => {
    const subject = testSession();

    const firstCall = subject.store.start() as MockPush;
    firstCall.mockReply("timeout");
    const secondCall = subject.store.start() as MockPush;
    secondCall.mockReply("ok");

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.errors.start).toBeNull();
    expect(subject.state.timeouts.start).toBe(false);
  });

  it("should cast without tracking replies", () => {
    const socket = new Socket("/socket") as MockSocket;
    const store = createSession<TestValue>(socket, {
      topic: "counter:lobby",
    }).extend(({ call, cast }) => ({
      start() {
        return call("server_start", {});
      },
      typing(payload: { active: boolean }) {
        cast("typing", payload);
      },
    }));
    let state: StoreStateOf<typeof store> | undefined;
    store.subscribe((nextState) => {
      state = nextState;
    });
    const channel = socket.mockChannels[0];

    const result = store.typing({ active: true });
    const message = channel.mockPushes[0];

    expect(result).toBeUndefined();
    expect(message.mockEvent).toBe("typing");
    expect(message.mockPayload).toEqual({ active: true });
    expect(message.receive).not.toHaveBeenCalled();
    expect(state?.processing.typing).toBe(false);
    expect(state?.errors.typing).toBeNull();
    expect(state?.timeouts.typing).toBe(false);
  });
});

describe("session action races", () => {
  it("should ignore older error replies after a newer run starts", () => {
    const subject = testSession();

    const firstStart = subject.store.start() as MockPush;
    const secondStart = subject.store.start() as MockPush;

    firstStart.mockReply("error", { reason: "stale" });

    expect(subject.state.processing.start).toBe(true);
    expect(subject.state.errors.start).toBeNull();

    secondStart.mockReply("ok");

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.errors.start).toBeNull();
  });

  it("should keep newer completion when older reply arrives later", () => {
    const subject = testSession();

    const firstStart = subject.store.start() as MockPush;
    const secondStart = subject.store.start() as MockPush;

    secondStart.mockReply("error", { reason: "newer" });
    firstStart.mockReply("ok");

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.errors.start).toEqual({ reason: "newer" });
  });

  it("should track different actions independently", () => {
    const subject = testSession();

    const startCall = subject.store.start() as MockPush;
    const saveCall = subject.store.save({ id: "one" }) as MockPush;

    expect(subject.state.processing.start).toBe(true);
    expect(subject.state.processing.save).toBe(true);

    startCall.mockReply("ok");

    expect(subject.state.processing.start).toBe(false);
    expect(subject.state.processing.save).toBe(true);

    saveCall.mockReply("error", { code: "invalid" });

    expect(subject.state.errors.save).toEqual({ code: "invalid" });
  });
});
