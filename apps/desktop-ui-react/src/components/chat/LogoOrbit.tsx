/**
 * 空态 Logo 轨道动画（canvas）。
 *
 * **绘制逻辑照搬** `docs/logo-orbit-loop.html` —— 与移动端 `web/src/components/LogoOrbit.vue`
 * 同源，两边保持同一套参数与画法：
 *   · logo 剪影用**泛洪填充**分离出 mask 与真实边界框（不是猜包围盒）；
 *   · 星在背面时先画到离屏画布，再用 mask 做 destination-out 挖掉被 logo 遮住的部分；
 *   · 彗尾沿轨道采样 240 点建**锥形多边形**，长度由瞬时速度（缓动导数）决定；
 *   · 星永不旋转、永不压扁；正面 105% / 背面 95%。
 *
 * 与移动端的两处差异（都是刻意的）：
 *   · 桌面空态没有「飞到繁忙位」那趟 FLIP，所以不带 logoFly 那套；
 *   · 相位基准用 performance.now() 的相对时间取模 —— 直接用 rAF 绝对时间戳取模会让
 *     首帧落在随机相位上（症状：一进页面只有浮动、没有旋转与彗星）。
 */
import { useEffect, useRef } from 'react'
import logoUrl from '../../assets/logo-orbit.png'

const D = Math.PI / 180

/** 像素默认值按 logo 宽 250 设计，运行期统一乘 s 缩放到实际尺寸。 */
const CFG = {
  loopMs: 4000,
  baseLogo: 250,
  floatPx: 20,
  starPx: 28,
  tailMin: 20,
  tailMax: 80,
  tilt: -35 * D,
  rx: 0.6,
  ry: 0.3,
  psiStart: 205 * D,
  psiEnd: -75 * D,
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const speedAt = (t: number): number => (t < 0.5 ? 12 * t * t : 12 * (1 - t) * (1 - t)) / 3
const smooth = (a: number, b: number, x: number): number => {
  const v = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return v * v * (3 - 2 * v)
}

interface St { psi: number; v: number; alpha: number; ox: number; oy: number; a: number; b: number }

export function LogoOrbit({ size = 72, mode = 'busy' }: { size?: number; mode?: 'idle' | 'busy' }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /// size 进依赖：尺寸变了要重新 layout（不要把 size 读成闭包里的旧值）。
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => {
    const hostEl = hostRef.current
    const canvasEl = canvasRef.current
    if (!hostEl || !canvasEl) return
    /* 一律用**显式非空类型**的别名：TS 不把控制流收窄带进下面这些闭包
       （frame / boot / layout / onResize 都是函数声明），直接用 ref 的值会在闭包里
       报「possibly null」。声明处给死类型，闭包里就没有可空的余地。 */
    const host: HTMLDivElement = hostEl
    const cv: HTMLCanvasElement = canvasEl
    const ctx: CanvasRenderingContext2D = canvasEl.getContext('2d') as CanvasRenderingContext2D
    const tmp = document.createElement('canvas')
    const tctx: CanvasRenderingContext2D = tmp.getContext('2d') as CanvasRenderingContext2D

    let L: { mask: HTMLCanvasElement; cx: number; cy: number; W: number; H: number } | null = null
    let dpr = 1, vw = 0, vh = 0, k = 1, s = 1, cx = 0, cy = 0
    let raf = 0
    let stopped = false
    let t0 = 0

    const img = new Image()

    function analyse(): void {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d', { willReadFrequently: true })
      if (!g) return
      g.drawImage(img, 0, 0)
      const px = g.getImageData(0, 0, w, h).data
      const out = new Uint8Array(w * h)
      const stack: number[] = []
      const push = (i: number): void => {
        if (!out[i] && px[i * 4 + 3] < 24) { out[i] = 1; stack.push(i) }
      }
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
      while (stack.length) {
        const i = stack.pop()!
        const x = i % w
        if (x > 0) push(i - 1)
        if (x < w - 1) push(i + 1)
        if (i >= w) push(i - w)
        if (i < w * (h - 1)) push(i + w)
      }
      const m = g.createImageData(w, h)
      let x0 = w, y0 = h, x1 = 0, y1 = 0
      for (let i = 0; i < w * h; i++) {
        if (out[i]) continue
        const x = i % w
        const y = (i / w) | 0
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        m.data[i * 4 + 3] = 255
      }
      const mask = document.createElement('canvas')
      mask.width = w
      mask.height = h
      mask.getContext('2d')?.putImageData(m, 0, 0)
      L = { mask, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, W: x1 - x0 + 1, H: y1 - y0 + 1 }
    }

    function layout(): void {
      if (!L) return
      const rect = host.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 3)
      vw = Math.max(1, rect.width)
      vh = Math.max(1, rect.height)
      cv.width = Math.round(vw * dpr)
      cv.height = Math.round(vh * dpr)
      const logoW = Math.min(sizeRef.current, Math.min(vw, vh) * 0.82)
      k = logoW / L.W
      s = logoW / CFG.baseLogo
      cx = vw / 2
      cy = vh / 2
    }

    function orbitPt(psi: number, ox: number, oy: number, a: number, b: number): [number, number] {
      const x = a * Math.cos(psi)
      const y = b * Math.sin(psi)
      const c = Math.cos(CFG.tilt)
      const n = Math.sin(CFG.tilt)
      return [ox + x * c - y * n, oy + x * n + y * c]
    }

    function starPath(g: CanvasRenderingContext2D, R: number): void {
      const q = R * 0.14
      g.beginPath()
      g.moveTo(0, -R)
      g.quadraticCurveTo(q, -q, R, 0)
      g.quadraticCurveTo(q, q, 0, R)
      g.quadraticCurveTo(-q, q, -R, 0)
      g.quadraticCurveTo(-q, -q, 0, -R)
      g.closePath()
    }

    function drawStar(g: CanvasRenderingContext2D, st: St): void {
      if (st.alpha < 0.003) return
      const sz = CFG.starPx * s
      const R = (sz / 2) * (1 + 0.05 * Math.sin(st.psi))
      const len = (CFG.tailMin + (CFG.tailMax - CFG.tailMin) * st.v) * s
      const P = (a: number): [number, number] => orbitPt(a, st.ox, st.oy, st.a, st.b)
      const head = P(st.psi)
      const pts: { p: [number, number]; d: number }[] = [{ p: head, d: 0 }]
      let acc = 0
      let prev = head
      for (let i = 1; i < 240 && acc < len; i++) {
        const q = P(st.psi + i * 0.03)
        const dd = Math.hypot(q[0] - prev[0], q[1] - prev[1])
        if (acc + dd >= len) {
          const f = (len - acc) / dd
          pts.push({ p: [prev[0] + (q[0] - prev[0]) * f, prev[1] + (q[1] - prev[1]) * f], d: len })
          break
        }
        acc += dd
        pts.push({ p: q, d: acc })
        prev = q
      }
      g.save()
      g.globalAlpha = st.alpha
      if (pts.length > 1) {
        const left: [number, number][] = []
        const right: [number, number][] = []
        for (let i = 0; i < pts.length; i++) {
          const p0 = pts[Math.max(i - 1, 0)].p
          const p1 = pts[Math.min(i + 1, pts.length - 1)].p
          let tx = p1[0] - p0[0]
          let ty = p1[1] - p0[1]
          const n = Math.hypot(tx, ty) || 1
          tx /= n
          ty /= n
          const hw = sz * 0.2 * Math.pow(1 - pts[i].d / len, 1.2)
          left.push([pts[i].p[0] - ty * hw, pts[i].p[1] + tx * hw])
          right.push([pts[i].p[0] + ty * hw, pts[i].p[1] - tx * hw])
        }
        const end = pts[pts.length - 1].p
        const gr = g.createLinearGradient(head[0], head[1], end[0], end[1])
        gr.addColorStop(0, 'rgba(196,222,255,.95)')
        gr.addColorStop(0.35, 'rgba(120,172,255,.55)')
        gr.addColorStop(1, 'rgba(70,120,230,0)')
        g.beginPath()
        g.moveTo(left[0][0], left[0][1])
        for (const p of left) g.lineTo(p[0], p[1])
        for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1])
        g.closePath()
        g.fillStyle = gr
        g.fill()
      }
      g.translate(head[0], head[1])
      const halo = g.createRadialGradient(0, 0, 0, 0, 0, R * 2.6)
      halo.addColorStop(0, 'rgba(130,180,255,.5)')
      halo.addColorStop(1, 'rgba(130,180,255,0)')
      g.fillStyle = halo
      g.beginPath()
      g.arc(0, 0, R * 2.6, 0, 7)
      g.fill()
      const body = g.createRadialGradient(0, 0, 0, 0, 0, R)
      body.addColorStop(0, '#e6f1ff')
      body.addColorStop(1, '#86b4f6')
      starPath(g, R)
      g.fillStyle = body
      g.fill()
      g.restore()
    }

    function logoXform(g: CanvasRenderingContext2D, rot: number, fy: number): void {
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.translate(cx, cy + fy)
      if (rot) g.rotate(rot)
      g.scale(k, k)
    }

    function frame(now: number): void {
      if (stopped || !L) return
      /// 相对时间取模：t 从 0 稳定爬升，起手不会落在随机相位。
      const t = ((now - t0) % CFG.loopMs) / CFG.loopMs
      const e = ease(t)
      const busy = mode === 'busy'
      const rot = busy ? 360 * D * e : 0
      const up = t < 0.5 ? Math.pow(2 * t, 2) : Math.pow(2 - 2 * t, 2)
      const fy = -CFG.floatPx * s * up
      const psi = CFG.psiStart + (CFG.psiEnd - CFG.psiStart) * e
      const st: St = {
        psi,
        v: speedAt(t),
        alpha: busy ? smooth(0, 0.16, e) * (1 - smooth(0.84, 1, e)) : 0,
        ox: cx,
        oy: cy + fy,
        a: CFG.rx * L.W * k,
        b: CFG.ry * L.H * k,
      }
      const front = Math.sin(psi) > 0
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cv.width, cv.height)
      if (busy && !front) {
        tctx.setTransform(1, 0, 0, 1, 0, 0)
        tctx.clearRect(0, 0, tmp.width, tmp.height)
        tctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawStar(tctx, st)
        tctx.save()
        tctx.globalCompositeOperation = 'destination-out'
        logoXform(tctx, rot, fy)
        tctx.drawImage(L.mask, -L.cx, -L.cy)
        tctx.restore()
        ctx.drawImage(tmp, 0, 0)
      }
      ctx.save()
      ctx.imageSmoothingQuality = 'high'
      logoXform(ctx, rot, fy)
      ctx.drawImage(img, -L.cx, -L.cy)
      ctx.restore()
      if (busy && front) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawStar(ctx, st) }
      raf = requestAnimationFrame(frame)
    }

    function boot(): void {
      analyse()
      layout()
      tmp.width = cv.width
      tmp.height = cv.height
      /// busy 的起点往前挪 0.42 个循环：一挂载就已经在轨道中段（星可见），
      /// 而不是从 e=0 的透明区慢慢淡入（观感是「等半秒，然后啪一下出现」）。
      t0 = performance.now() - (mode === 'busy' ? CFG.loopMs * 0.42 : 0)
      if (!stopped) raf = requestAnimationFrame(frame)
    }

    img.onload = boot
    img.src = logoUrl
    const onResize = (): void => {
      layout()
      tmp.width = cv.width
      tmp.height = cv.height
    }
    window.addEventListener('resize', onResize)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [mode])

  return (
    <div ref={hostRef} className='logo-orbit' style={{ width: size, height: size }} aria-hidden='true'>
      <canvas ref={canvasRef} className='logo-orbit-canvas' />
    </div>
  )
}
