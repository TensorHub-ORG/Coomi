import logo from '../../assets/coomi-logo.png'
import { useDeck } from '../../stores/deck'
export function ModeSwitch() {
  const mode = useDeck((state) => state.mode)
  const toggle = useDeck((state) => state.toggle)
  return <button type='button' className='mode-switch no-drag' aria-label={'当前 ' + (mode === 'work' ? 'Work' : 'Deck') + '，切换模式'} title={'切换到 ' + (mode === 'work' ? 'Deck 任务调度' : 'Work 会话')} onClick={toggle} data-mode={mode}>
    <img src={logo} width={22} height={22} alt='' />
    <span className='mode-switch-label'><span key={mode}>{mode === 'work' ? 'Work' : 'Deck'}</span></span>
  </button>
}
