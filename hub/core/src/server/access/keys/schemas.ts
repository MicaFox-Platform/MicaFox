import { Type } from "typebox";

const uuid = Type.String({ format: "uuid" });
const dateTime = Type.String({ format: "date-time" });

export const keyParams = Type.Object({ keyId: uuid });

const keyProperties = {
  id: uuid,
  name: Type.String(),
  prefix: Type.String(),
  createdBy: Type.Union([uuid, Type.Null()]),
  createdAt: dateTime,
  lastUsedAt: Type.Union([dateTime, Type.Null()]),
};

/** A key as the list answers it: never the token. */
export const keyReply = Type.Object(keyProperties);

/** What creating a key answers, once: the key and its token with the URL to give the SDK. */
export const createdKeyReply = Type.Object({ ...keyProperties, token: Type.String(), hubUrl: Type.String() });

export const noContent = Type.Null();
