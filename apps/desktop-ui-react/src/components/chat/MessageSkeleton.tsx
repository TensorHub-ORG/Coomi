/** 历史回读期间的骨架屏。骨架为静态灰底（扫光效果已按「动效审计」移除）。
    切会话 / 启动恢复 lastSession 时，历史是异步回来的：这段时间里既不能渲染「新对话」hero
    （那会让人以为会话空了），也不能什么都不画（会闪一下白）。用消息形状的骨架把位置占住，
    等 historyLoaded 变 true 再换成真内容。 */
export function MessageSkeleton() {
  return (
    <div
      data-chat-skeleton
      aria-busy='true'
      aria-label='正在加载会话'
      className='min-h-0 flex-1 overflow-hidden py-5'
    >
      <div className='mx-auto w-full max-w-[var(--content-w)] px-2'>
        {[0, 1, 2].map((i) => (
          <div key={i} className='flex flex-col gap-3 py-3'>
            {/* 用户气泡：右对齐的短块 */}
            <div className='skeleton ml-auto h-8 w-[42%] rounded-[18px] rounded-tr-[6px]' />
            {/* 助手回复：几行宽度递减的细块 */}
            <div className='flex flex-col gap-2'>
              <div className='skeleton h-3.5 w-[86%] rounded' />
              <div className='skeleton h-3.5 w-[74%] rounded' />
              <div className='skeleton h-3.5 w-[52%] rounded' />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
