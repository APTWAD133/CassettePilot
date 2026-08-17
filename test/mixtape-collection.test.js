import test from "node:test";
import assert from "node:assert/strict";
import {
  insertMixtapeInLayout,
  moveMixtapesToGroup,
  moveMixtapesToTopLevel,
  moveTopLevelNode,
  normalizeCollectionLayout
} from "../src/mixtape-collection.js";

test("legacy flat collections gain a stable top-level order", () => {
  const items = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(normalizeCollectionLayout(items), {
    groups: [],
    order: [{ type: "mixtape", id: "a" }, { type: "mixtape", id: "b" }]
  });
});

test("layout normalization removes missing and multiply assigned mixtapes", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const groups = [
    { id: "g1", name: "One", itemIds: ["b", "missing"] },
    { id: "g2", name: "Two", itemIds: ["b", "c"] }
  ];
  const layout = normalizeCollectionLayout(items, groups, [
    { type: "mixtape", id: "b" },
    { type: "group", id: "g2" },
    { type: "mixtape", id: "a" }
  ]);
  assert.deepEqual(layout.groups.map((group) => group.itemIds), [["b"], ["c"]]);
  assert.deepEqual(layout.order, [
    { type: "group", id: "g2" },
    { type: "mixtape", id: "a" },
    { type: "group", id: "g1" }
  ]);
});

test("mixtapes can move between groups and the top level", () => {
  const store = {
    groups: [{ id: "g", name: "Group", itemIds: ["b"], collapsed: false }],
    order: [{ type: "mixtape", id: "a" }, { type: "group", id: "g" }]
  };
  insertMixtapeInLayout(store, "a", { groupId: "g", index: 0 });
  assert.deepEqual(store.groups[0].itemIds, ["a", "b"]);
  assert.deepEqual(store.order, [{ type: "group", id: "g" }]);
  insertMixtapeInLayout(store, "b", { index: 0 });
  assert.deepEqual(store.groups[0].itemIds, ["a"]);
  assert.deepEqual(store.order[0], { type: "mixtape", id: "b" });
});

test("top-level nodes reorder without duplication", () => {
  const store = {
    groups: [],
    order: [
      { type: "mixtape", id: "a" },
      { type: "group", id: "g" },
      { type: "mixtape", id: "b" }
    ]
  };
  assert.equal(moveTopLevelNode(store, { type: "mixtape", id: "a" }, 3), true);
  assert.deepEqual(store.order.map((node) => node.id), ["g", "b", "a"]);
});

test("multiple selected mixtapes move into a group in selection order", () => {
  const store = {
    groups: [
      { id: "source", name: "Source", itemIds: ["b"], collapsed: false },
      { id: "target", name: "Target", itemIds: ["d"], collapsed: true }
    ],
    order: [
      { type: "mixtape", id: "a" },
      { type: "group", id: "source" },
      { type: "mixtape", id: "c" },
      { type: "group", id: "target" }
    ]
  };
  assert.equal(moveMixtapesToGroup(store, ["a", "b", "c"], "target"), true);
  assert.deepEqual(store.groups[0].itemIds, []);
  assert.deepEqual(store.groups[1].itemIds, ["d", "a", "b", "c"]);
  assert.equal(store.groups[1].collapsed, false);
  assert.deepEqual(store.order, [
    { type: "group", id: "source" },
    { type: "group", id: "target" }
  ]);
});

test("multiple selected mixtapes are ungrouped together at a top-level drop", () => {
  const store = {
    groups: [
      { id: "source", name: "Source", itemIds: ["a", "b", "c"], collapsed: false },
      { id: "target", name: "Target", itemIds: [], collapsed: false }
    ],
    order: [
      { type: "group", id: "source" },
      { type: "mixtape", id: "d" },
      { type: "group", id: "target" }
    ]
  };
  assert.equal(moveMixtapesToTopLevel(
    store,
    ["a", "c"],
    { type: "mixtape", id: "d" },
    "after"
  ), true);
  assert.deepEqual(store.groups[0].itemIds, ["b"]);
  assert.deepEqual(store.order, [
    { type: "group", id: "source" },
    { type: "mixtape", id: "d" },
    { type: "mixtape", id: "a" },
    { type: "mixtape", id: "c" },
    { type: "group", id: "target" }
  ]);
});
