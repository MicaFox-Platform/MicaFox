# MicaFox hub

## Installation

The hub is an image, `ghcr.io/micafox-platform/hub`, not an npm package. It needs Postgres 15 or later and HTTPS in
front of it for anything but `localhost`.

**Docker Compose** — download `compose.yaml`, `Caddyfile` and `postgres-init.sql` from the hub's GitHub Release,
then:

```sh
cat > .env <<'END'
MICAFOX_DOMAIN=hub.example.com
POSTGRES_PASSWORD=<a long random password>
MICAFOX_DB_OWNER_PASSWORD=<another one>
MICAFOX_DB_APP_PASSWORD=<another one>
END
docker compose up -d
docker compose logs hub | grep setup   # the one-time setup token
```

Caddy gets a certificate for `MICAFOX_DOMAIN`; open `https://<domain>/setup` and enter the token. To try the hub on
one machine, leave `MICAFOX_DOMAIN` unset and open `http://localhost:8080/setup`.

**Kubernetes** — install the chart with a Postgres you run, given as a Secret with the app role's URL:

```sh
helm install hub oci://ghcr.io/micafox-platform/charts/hub \
  --set publicUrl=https://hub.example.com \
  --set database.existingSecret=hub-db \
  --set size=small
```

The chart runs one replica with the `Recreate` strategy, as non-root on a read-only root filesystem.

What a hub promises:

- It sends nothing anywhere: no telemetry, and licences are checked offline.
- Any released version upgrades to the latest by starting the new image; take a `pg_dump` first, since migrations
  only go forward and a downgrade is a restore.
- Organizations are isolated by Postgres row-level security.
- Its HTTP API under `/api/v1` stays compatible until `/api/v2`, and `/api/v1` stays one more minor version after.

### Sizing

| Size     | Machine next to Postgres | Serves                                                     |
| -------- | ------------------------ | ---------------------------------------------------------- |
| `small`  | 1 vCPU, 1 GB             | 200 connected SDK instances, 50 snapshots a second         |
| `medium` | 2 vCPU, 2 GB             | twice the limits of `small`; measured by the hub benchmark |
| `large`  | 4 vCPU, 4 GB             | four times the limits of `small`; measured likewise        |

The chart's `size` sets the resources and the matching [settings](config.md#settings); with Compose, set those
settings yourself.

## Exports

- [HTTP API](http.md) — `/api/v1`: conventions, errors, pagination and the endpoints of the hub's core.
- [Configuration](config.md) — every setting, the `micafox-hub` commands, health and metrics.

The SDK connects to `wss://<hub>/sdk` with a project key: [SDK usage](../sdk/overview.md#usage) and
[the handshake](../protocol.md#hello).

## Usage

From a fresh hub to a connected app:

1. Open `/setup` with the setup token from the hub's log; create the organization and its owner.
2. Create a project; it starts with a `production` environment. In the project's settings, create a key for it.
3. Copy the two lines shown once into your app's deployment, and start the SDK:

```sh
MICAFOX_HUB_URL=wss://hub.example.com/sdk
MICAFOX_TOKEN=mfx_pk_...
MICAFOX_SERVICE=checkout
```

4. Invite your team from the organization's settings: each invite is a link you send them yourself.

Architecture: [hub overview](../../architecture/hub/overview.md).
