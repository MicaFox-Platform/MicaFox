import type { Connector } from "@micafox/protocol";

import { findHubOptions, isConnector, type ConfiguredOptions } from "./options.js";
import {
  checkHubTarget,
  isRecord,
  LOGGER_KEY,
  MODULES_KEY,
  readField,
  resolveOptions,
  type HubConnectorOptions,
  type HubTarget,
  type Warn,
} from "../connector/index.js";
import type { Environment, SdkLogger } from "../logger/index.js";

const COMPONENT = "debugger";
// The module this SDK part runs, which the connector sends in `hello`
const MODULE = "debugger";

/** The connector one `run()` uses, and what the "started" line calls it. */
export interface ConnectorChoice {
  readonly connector: Connector;
  /** Created by `run()`, so `stop()` closes it; a custom connector is left open for the app. */
  readonly isOwned: boolean;
  readonly description: string;
}

/** What `chooseConnector()` needs from the debugger. */
export interface ChoiceContext {
  env: Environment;
  logger: SdkLogger;
  warn: Warn;
  createHubConnector: (options: HubConnectorOptions) => Connector;
}

// The tuning fields of `hubConnector`; the hub's address and the logger have options of their own
const TUNING_NAMES = ["buffer", "batch", "rateLimit", "reconnect", "closeTimeoutMs"];

// Reads only the tuning fields, each once, so a getter that throws is skipped with a warning like any other option
const readTuning = (value: unknown, warn: Warn): Record<string, unknown> => {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    warn("hubConnector must be an object; using its defaults");
    return {};
  }

  const tuning: Record<string, unknown> = {};
  for (const name of TUNING_NAMES) {
    const field = readField(value, name, (message) => {
      warn(`hubConnector.${message}`);
    });
    if (field !== undefined) {
      tuning[name] = field;
    }
  }

  return tuning;
};

/**
 * The options of the `HubConnector` that `run()` creates: the hub fields as configured, the tuning of `hubConnector`
 * and the debugger's logger and its module under the keys the connector reads (docs/architecture/sdk/logger.md#interactions).
 */
const createHubOptions = (options: ConfiguredOptions, { logger, warn }: ChoiceContext): HubConnectorOptions => {
  const hubOptions = {
    ...readTuning(options.hubConnector, warn),
    url: options.url,
    token: options.token,
    service: options.service,
    labels: options.labels,
    [LOGGER_KEY]: logger,
    [MODULES_KEY]: [MODULE],
  };
  // Safe: the fields are as the app passed them, and the connector validates each one itself
  return hubOptions as HubConnectorOptions;
};

// Names the hub connector for the "started" line by its service and the host of the checked URL; never by the token
const describeHub = (target: HubTarget, service: string | undefined): string =>
  `the hub connector (service ${service ?? "not set"}, hub host ${new URL(target.href).host})`;

const logNotStarted = (logger: SdkLogger, reason: string): undefined => {
  logger.log("error", `${reason}; not started`, { component: COMPONENT });
  return undefined;
};

const createHub = (options: ConfiguredOptions, context: ChoiceContext): ConnectorChoice | undefined => {
  const hubOptions = createHubOptions(options, context);
  // Resolved as the connector resolves them; it warns about invalid values itself when it is created
  const { url, token, service } = resolveOptions(hubOptions, { env: context.env, warn: () => undefined });
  if (url === undefined) {
    logNotStarted(context.logger, "no hub URL: set url or MICAFOX_HUB_URL, or a connector");
    return;
  }

  // The connector would refuse this target at connect() and never connect, so the debugger does not start either
  const check = checkHubTarget(url, token);
  if (!check.ok) {
    logNotStarted(context.logger, check.reason);
    return;
  }

  const connector = context.createHubConnector(hubOptions);
  return { connector, isOwned: true, description: describeHub(check.target, service) };
};

/**
 * Takes the custom `connector` of the options, or creates a `HubConnector` from them; `undefined` after logging why
 * there is none.
 */
export const chooseConnector = (options: ConfiguredOptions, context: ChoiceContext): ConnectorChoice | undefined => {
  const { connector } = options;
  if (connector === undefined) {
    return createHub(options, context);
  }

  if (!isConnector(connector)) {
    context.logger.log("error", "connector is not a Connector; not started", { component: COMPONENT });
    return undefined;
  }

  const ignored = findHubOptions(options);
  if (ignored.length > 0) {
    context.warn(`${ignored.join(", ")} ignored: a custom connector is set`);
  }

  return { connector, isOwned: false, description: "a custom connector" };
};
