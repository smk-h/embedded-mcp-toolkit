/**
 * @file src/cli/commands/remote-mcp-config/json-mutate.ts
 * @brief C2. JSON 按 path 操作（纯函数，操作本地内存中的 JSON 对象）
 *
 * 按 JSON 路径取/设/删嵌套对象与使能数组。全部为纯函数，入参为普通对象/数组，
 * 不依赖任何外部状态。
 */

// ============================================================
// C2. JSON 按 path 操作（纯函数，操作本地内存中的 JSON 对象）
// ============================================================

/**
 * @brief 按 path 取嵌套对象
 * @details 沿 path 逐层取键；任一层缺失或非对象则返回 null。
 * @param obj  根对象
 * @param path JSON 路径（如 ["mcp","servers"]）
 * @returns path 指向的对象；不存在返回 null
 */
export function getAtPath(
  obj: Record<string, unknown>,
  path: string[]
): Record<string, unknown> | null {
  let current: unknown = obj;
  for (const key of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (
    current === null ||
    current === undefined ||
    typeof current !== "object" ||
    Array.isArray(current)
  ) {
    return null;
  }
  return current as Record<string, unknown>;
}

/**
 * @brief 按 path 取任意类型值（不排斥数组）
 * @details 与 getAtPath 的区别：本函数用于取"使能数组"这类叶子值，末层若是数组也
 *          原样返回（getAtPath 会把数组当无效对象返回 null）。中间层仍要求为普通
 *          对象（数组不能作为中间容器）。
 * @param obj  根对象
 * @param path JSON 路径（如 ["enabledMcpjsonServers"]）
 * @returns path 指向的值；中间层缺失或非对象返回 null
 */
export function getValueAtPath(
  obj: Record<string, unknown>,
  path: string[]
): unknown {
  let current: unknown = obj;
  // 中间层（path[0..n-2]）必须为普通对象
  for (let i = 0; i < path.length - 1; i++) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[path[i]];
  }
  if (
    current === null ||
    current === undefined ||
    typeof current !== "object"
  ) {
    return null;
  }
  // 末层：取值（可为任意类型，含数组）
  return (current as Record<string, unknown>)[path[path.length - 1]];
}

/**
 * @brief 在 path 指向的容器中设置 server（保留同容器其它 key）
 * @details 沿 path 逐层取/建对象（缺失则创建空对象），最后设置 container[key]=server。
 * @param obj    根对象（会被原地修改）
 * @param path   server 容器的 JSON 路径
 * @param key    server key 名
 * @param server server 对象
 */
export function setServerAtPath(
  obj: Record<string, unknown>,
  path: string[],
  key: string,
  server: object
): void {
  let current: Record<string, unknown> = obj;
  for (const segment of path) {
    let next = current[segment];
    // 缺失或非对象则创建/重建为空对象
    if (
      next === null ||
      next === undefined ||
      typeof next !== "object" ||
      Array.isArray(next)
    ) {
      next = {};
      current[segment] = next;
    }
    current = next as Record<string, unknown>;
  }
  current[key] = server;
}

/**
 * @brief 从 path 指向的容器中删除 server key
 * @param obj  根对象
 * @param path server 容器的 JSON 路径
 * @param key  server key 名
 * @returns 是否实际删除（容器存在且含 key 返回 true）
 */
export function removeServerAtPath(
  obj: Record<string, unknown>,
  path: string[],
  key: string
): boolean {
  const container = getAtPath(obj, path);
  if (!container) return false;
  if (!(key in container)) return false;
  delete container[key];
  return true;
}

/**
 * @brief 使能数组去重追加
 * @param arr   使能数组
 * @param value 要追加的值
 * @returns 是否新增（已存在返回 false）
 */
export function ensureInArray(arr: unknown[], value: string): boolean {
  if (arr.includes(value)) return false;
  arr.push(value);
  return true;
}

/**
 * @brief 使能数组移除
 * @param arr   使能数组
 * @param value 要移除的值
 * @returns 是否实际移除
 */
export function removeFromArray(arr: unknown[], value: string): boolean {
  const idx = arr.indexOf(value);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
}
