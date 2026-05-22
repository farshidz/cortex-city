import test from "node:test";
import assert from "node:assert/strict";
import { isSidebarNavLinkActive } from "./sidebar-nav-link";

test("isSidebarNavLinkActive matches section roots and nested pages", () => {
  assert.equal(isSidebarNavLinkActive("/", ["/", "/tasks"]), true);
  assert.equal(isSidebarNavLinkActive("/tasks/task-1", ["/", "/tasks"]), true);
  assert.equal(
    isSidebarNavLinkActive("/tasks/task-1/session", ["/", "/tasks"]),
    true
  );
  assert.equal(isSidebarNavLinkActive("/issues/issue-1", ["/issues"]), true);
  assert.equal(isSidebarNavLinkActive("/reviews/123", ["/reviews"]), true);
});

test("isSidebarNavLinkActive does not match partial section names", () => {
  assert.equal(isSidebarNavLinkActive("/tasks-archive", ["/", "/tasks"]), false);
  assert.equal(isSidebarNavLinkActive("/issues-extra", ["/issues"]), false);
  assert.equal(isSidebarNavLinkActive("/reviews-old/123", ["/reviews"]), false);
});
