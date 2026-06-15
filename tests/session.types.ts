import type { Socket } from "phoenix";
import { defer, session } from "../src";

type RoomValue = {
  started: boolean;
};

type StartOk = {
  accepted: true;
};

type StartError = {
  reason?: string;
};

declare const socket: Pick<Socket, "channel">;

const deferredRoom = defer<RoomValue>({
  value: { started: false },
  connect: {
    ok: (_value, reply: RoomValue) => reply,
  },
  events: {
    projection: (_value, payload: RoomValue) => payload,
  },
});

deferredRoom.attach(socket, { topic: "room:lobby" });
deferredRoom.detach();

const deferredActions = deferredRoom.session.extend(({ call }) => ({
  start(payload: { mode: "solo" | "party" }) {
    return call<StartOk, StartError>("start", payload);
  },
}));

deferredActions.subscribe((state) => {
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

// @ts-expect-error extended store exposes only subscribe and action methods
room.push("dynamic_event", {});

// @ts-expect-error extended store does not expose action context call
room.call("dynamic_event", {});

// @ts-expect-error extended store does not expose action context cast
room.cast("dynamic_event", {});
