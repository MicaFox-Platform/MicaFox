import type { FastifyError, FastifySchemaValidationError } from "fastify";

import type { FieldError, FieldLocation, ProblemDetails } from "./catalog.js";

// Fastify names the part of the request that failed; its type is not exported
type ValidationContext = NonNullable<FastifyError["validationContext"]>;

const LOCATIONS: Record<ValidationContext, FieldLocation> = {
  body: "body",
  querystring: "query",
  params: "params",
  headers: "headers",
};

// A property name is one JSON Pointer token: RFC 6901 escapes `~` and `/`
const toPointerToken = (name: string): string => name.replaceAll("~", "~0").replaceAll("/", "~1");

// Ajv puts a missing property in `params`, not in the path of the object that lacks it
const pathOf = (error: FastifySchemaValidationError): string => {
  const missing = error.keyword === "required" ? error.params.missingProperty : undefined;
  return typeof missing === "string" ? `${error.instancePath}/${toPointerToken(missing)}` : error.instancePath;
};

const labelOf = (error: FieldError): string => (error.path === "" ? error.in : error.path.slice(1));

/** Turns the schema errors of one part of a request into the details of a `validation` problem. */
export const toValidationDetails = (
  errors: readonly FastifySchemaValidationError[],
  context: ValidationContext | undefined,
): ProblemDetails => {
  const location = LOCATIONS[context ?? "body"];
  const fieldErrors = errors.map((error): FieldError => ({
    path: pathOf(error),
    in: location,
    message: error.message ?? "is not valid",
  }));
  const [first] = fieldErrors;
  return first === undefined ? {} : { detail: `${labelOf(first)}: ${first.message}`, errors: fieldErrors };
};
