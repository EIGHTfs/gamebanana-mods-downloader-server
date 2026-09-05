// test/smoke.test.cjs —— P0 基建冒烟：cjs-bootstrap + node:test + 测试日志
const { makeLog, loggedTest } = require("./helpers/test-log.cjs");
const assert = require("node:assert/strict");

const log = makeLog("smoke");

loggedTest(log, "cjs-bootstrap 让 server .js 以 CJS 加载（否则 ESM 父目录报 ERR_REQUIRE_ESM）", async () => {
  const mapping = require("../server/lib/mapping.js");
  log.info("mapping.buildTargetDir = " + typeof mapping.buildTargetDir);
  assert.equal(typeof mapping.buildTargetDir, "function");
  const organize = require("../server/lib/organize.js");
  log.info("organize.organizeDir = " + typeof organize.organizeDir);
  assert.equal(typeof organize.organizeDir, "function");
});
