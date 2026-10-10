; Tauri NSIS 安装钩子 —— 升级前清掉上一版的前端产物。
;
; 为什么需要：NSIS 只**覆盖与新增**文件，**从不删除**上一版有、这一版没有的文件。
; 前端是按内容哈希分包的（index-D06ovrnu.js 之类），每次构建的哈希都不同，
; 于是每次覆盖安装都往 $INSTDIR\ui-dist 里再留一份旧分包 —— 实测 5 次安装后
; 累积了 509 个未被 index.html 引用的死文件、40.1 MB。
;
; 只删 ui-dist（纯前端产物，可安全重建）：coomi.exe 走覆盖安装即可，不删，
; 避免"删了但新包没装上"导致引擎缺失。ui-dist 在 Tauri 的打包里是整体替换的资源，
; 删除后紧接着就会被本次安装重新写入。
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "清理上一版前端产物 (ui-dist)..."
  RMDir /r "$INSTDIR\ui-dist"
  ; 引擎是独立进程：壳退出后它仍锁着 coomi.exe，不杀就替换不了（旧引擎残留的元凶）。
  nsExec::Exec 'taskkill /F /IM coomi.exe /T'
  nsExec::Exec 'taskkill /F /IM coomi-desktop.exe /T'
!macroend

; 安装完成后自动拉起新版本：更新是「提权安装 + 旧进程已退出」的流程，
; 装完没人启动新 exe 的话用户会以为更新失败了。
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "启动新版本 (coomi-desktop)..."
  Exec '"$INSTDIR\coomi-desktop.exe"'
!macroend
