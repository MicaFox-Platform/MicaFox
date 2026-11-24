import { Type } from "typebox";

const uuid = Type.String({ format: "uuid" });
const email = Type.String({ format: "email", maxLength: 254 });

// Any password is tried at login, however short, and answers 401; its length is bounded so scrypt never gets a megabyte
export const loginBody = Type.Object({ email, password: Type.String({ minLength: 1, maxLength: 256 }) });

export const passwordBody = Type.Object({
  currentPassword: Type.String({ minLength: 1, maxLength: 256 }),
  newPassword: Type.String({ minLength: 12, maxLength: 256 }),
});

/** `GET /api/v1/session`, and what logging in and setting up answer. */
export const sessionReply = Type.Object({
  user: Type.Object({ id: uuid, name: Type.String(), email: Type.String() }),
  memberships: Type.Array(
    Type.Object({
      orgId: uuid,
      orgName: Type.String(),
      role: Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member")]),
    }),
  ),
});

export const noContent = Type.Null();
