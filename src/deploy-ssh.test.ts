import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const deployScript = readFileSync(
  path.join(process.cwd(), "scripts/deploy-ssh.sh"),
  "utf8"
);

function publishingCommands(): string {
  const start = deployScript.indexOf(
    'log "Publishing staged release and restarting services"'
  );
  const end = deployScript.indexOf('log "Deploy complete"', start);

  assert.notEqual(start, -1, "publish section should exist");
  assert.notEqual(end, -1, "deploy completion marker should exist");
  return deployScript.slice(start, end);
}

test("publishing does not recursively change ownership of live runtime files", () => {
  const commands = publishingCommands();
  const appOwnershipCommand =
    '$SUDO chown $(quote "$SYSTEMD_USER:$SYSTEMD_GROUP") $(quote "$APP_DIR")';

  assert.ok(commands.includes(appOwnershipCommand));
  assert.ok(!commands.includes(appOwnershipCommand.replace("chown ", "chown -R ")));
});

test("publish exclusions protect only app-level persistent directories", () => {
  const commands = publishingCommands();

  for (const pattern of [
    "/.cortex/",
    "/.deploy/",
    "/.tmp/",
    "/tmp/",
    "/logs/",
  ]) {
    assert.ok(
      commands.includes(`--exclude='${pattern}'`),
      `expected root-scoped exclusion for ${pattern}`
    );
  }
});
