function validId(value) {
  return typeof value === "string" && value.length > 0;
}

export function collectionNodeKey(type, id) {
  return `${type}:${id}`;
}

export function parseCollectionNodeKey(key) {
  const separator = String(key || "").indexOf(":");
  if (separator < 1) return null;
  const type = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return (type === "mixtape" || type === "group") && validId(id) ? { type, id } : null;
}

export function normalizeCollectionLayout(items, savedGroups, savedOrder) {
  const itemIds = new Set(items.map((item) => item.id).filter(validId));
  const seenGroups = new Set();
  const assignedItems = new Set();
  const groups = [];

  for (const candidate of Array.isArray(savedGroups) ? savedGroups : []) {
    if (!validId(candidate?.id) || seenGroups.has(candidate.id)) continue;
    seenGroups.add(candidate.id);
    const groupItems = [];
    for (const itemId of Array.isArray(candidate.itemIds) ? candidate.itemIds : []) {
      if (!itemIds.has(itemId) || assignedItems.has(itemId)) continue;
      assignedItems.add(itemId);
      groupItems.push(itemId);
    }
    groups.push({
      id: candidate.id,
      name: String(candidate.name || "Untitled Group").trim() || "Untitled Group",
      itemIds: groupItems,
      collapsed: Boolean(candidate.collapsed)
    });
  }

  const groupIds = new Set(groups.map((group) => group.id));
  const order = [];
  const orderedKeys = new Set();
  for (const candidate of Array.isArray(savedOrder) ? savedOrder : []) {
    const type = candidate?.type;
    const id = candidate?.id;
    const valid = type === "group"
      ? groupIds.has(id)
      : type === "mixtape" && itemIds.has(id) && !assignedItems.has(id);
    const key = collectionNodeKey(type, id);
    if (!valid || orderedKeys.has(key)) continue;
    orderedKeys.add(key);
    order.push({ type, id });
  }

  for (const group of groups) {
    const key = collectionNodeKey("group", group.id);
    if (!orderedKeys.has(key)) order.push({ type: "group", id: group.id });
  }
  for (const item of items) {
    const key = collectionNodeKey("mixtape", item.id);
    if (!assignedItems.has(item.id) && !orderedKeys.has(key)) order.push({ type: "mixtape", id: item.id });
  }

  return { groups, order };
}

export function removeMixtapeFromLayout(store, mixtapeId) {
  store.order = store.order.filter((node) => !(node.type === "mixtape" && node.id === mixtapeId));
  for (const group of store.groups) {
    group.itemIds = group.itemIds.filter((id) => id !== mixtapeId);
  }
}

export function insertMixtapeInLayout(store, mixtapeId, { groupId = null, index = null } = {}) {
  removeMixtapeFromLayout(store, mixtapeId);
  const group = groupId ? store.groups.find((candidate) => candidate.id === groupId) : null;
  if (group) {
    const targetIndex = index == null ? group.itemIds.length : Math.max(0, Math.min(index, group.itemIds.length));
    group.itemIds.splice(targetIndex, 0, mixtapeId);
    return;
  }
  const targetIndex = index == null ? store.order.length : Math.max(0, Math.min(index, store.order.length));
  store.order.splice(targetIndex, 0, { type: "mixtape", id: mixtapeId });
}

export function moveTopLevelNode(store, source, targetIndex) {
  const sourceIndex = store.order.findIndex((node) => node.type === source.type && node.id === source.id);
  if (sourceIndex < 0) return false;
  const [node] = store.order.splice(sourceIndex, 1);
  const adjustedIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  store.order.splice(Math.max(0, Math.min(adjustedIndex, store.order.length)), 0, node);
  return true;
}

export function moveMixtapesToGroup(store, mixtapeIds, groupId) {
  const group = store.groups.find((candidate) => candidate.id === groupId);
  if (!group) return false;
  const uniqueIds = [...new Set(mixtapeIds)];
  for (const mixtapeId of uniqueIds) removeMixtapeFromLayout(store, mixtapeId);
  group.itemIds.push(...uniqueIds);
  group.collapsed = false;
  return true;
}

export function moveMixtapesToTopLevel(store, mixtapeIds, target = null, position = "after") {
  const uniqueIds = [...new Set(mixtapeIds)];
  if (!uniqueIds.length) return false;
  const targetIsTopLevel = target == null || store.order.some((node) =>
    node.type === target.type && node.id === target.id
  );
  if (!targetIsTopLevel) return false;

  for (const mixtapeId of uniqueIds) removeMixtapeFromLayout(store, mixtapeId);
  const targetIndex = target == null
    ? store.order.length
    : store.order.findIndex((node) => node.type === target.type && node.id === target.id);
  const insertionIndex = targetIndex < 0
    ? store.order.length
    : targetIndex + (position === "after" ? 1 : 0);
  store.order.splice(
    insertionIndex,
    0,
    ...uniqueIds.map((id) => ({ type: "mixtape", id }))
  );
  return true;
}
