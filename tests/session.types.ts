import type { Socket } from "phoenix";
import { session } from "../src";

type RoomValue = {
  started: boolean;
};

type StartOk = {
  accepted: true;
};

type StartError = {
  reason?: string;
};

declare const socket: Socket;

const lazyRoom = session<RoomValue>({
  value: { started: false },
  connect: {
    ok: (_value, reply: RoomValue) => reply,
  },
  events: {
    projection: (_value, payload: RoomValue) => payload,
  },
});

lazyRoom.attach(socket, { topic: "room:lobby" });
lazyRoom.detach();

const lazyActions = lazyRoom.extend(({ call }) => ({
  start(payload: { mode: "solo" | "party" }) {
    return call<StartOk, StartError>("start", payload);
  },
}));

lazyActions.attach(socket, { topic: "room:lobby" });
lazyActions.detach();
const chainedActions = lazyActions.extend(({ cast }) => ({
  stop() {
    cast("stop", {});
  },
}));
chainedActions.start({ mode: "party" });
chainedActions.stop();

lazyActions.subscribe((state) => {
  state.value?.started;
  state.processing.start;
  state.errors.start?.reason;
});

const room = session<RoomValue>(socket, {
  topic: "room:lobby",
  connect: {
    ok: (_value, reply: RoomValue) => reply,
  },
  events: {
    projection: (_value, payload: RoomValue) => payload,
  },
}).extend(({ call, cast }) => ({
  start(payload: { mode: "solo" | "party" }) {
    return call<StartOk, StartError>("start", payload);
  },
  stop() {
    cast("stop", {});
  },
}));

const startCall = room.start({ mode: "solo" });
room.stop();
room.attach(socket, { topic: "room:lobby" });
room.detach();

startCall.receive("ok", (reply) => {
  reply.accepted;
});
startCall.receive("error", (reply) => {
  reply.reason;
});

room.subscribe((state) => {
  state.value?.started;
  state.processing.start;
  state.processing.stop;
  state.errors.start?.reason;
  state.timeouts.start;
  state.timeouts.stop;

  // @ts-expect-error typed action error replies can be absent
  state.errors.start.reason;

  // @ts-expect-error untyped action error replies are unknown until narrowed
  state.errors.stop?.reason;

  // @ts-expect-error unknown action bucket
  state.processing.start2;

  // @ts-expect-error unknown action bucket
  state.errors.start2;

  // @ts-expect-error unknown action bucket
  state.timeouts.start2;
});

// @ts-expect-error invalid payload option
room.start({ mode: "duo" });

// @ts-expect-error missing payload
room.start();

// @ts-expect-error stop has no payload
room.stop({});

// @ts-expect-error extended store does not expose low-level push
room.push("dynamic_event", {});

// @ts-expect-error extended store does not expose action context call
room.call("dynamic_event", {});

// @ts-expect-error extended store does not expose action context cast
room.cast("dynamic_event", {});
