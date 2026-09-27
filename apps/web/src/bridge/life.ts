/**
 * 数字生命体前端常量：全局常驻会话。
 *
 * 与 Rust 侧 `ui/src/life.rs` 的 GLOBAL_SESSION_ID 严格一致（引擎启动自愈 + 投递目标）。
 * 这条会话在侧边栏永远置顶、不可删除；所有主动交互（气泡/开场问候）只发生在它里面。
 */
export const GLOBAL_SESSION_ID = '50a1b732-5f3e-4b7d-8c2a-b9f4e6d1a001'

export function isGlobalSession(id: string): boolean {
  return id === GLOBAL_SESSION_ID
}
