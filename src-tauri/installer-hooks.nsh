; Ganchos do instalador NSIS gerado pelo Tauri.
; Pergunta se o widget deve iniciar com o Windows. Usa a mesma entrada de registro
; do plugin de autostart (HKCU\...\Run, valor "Agenda Widget"), então o ✓
; "Iniciar com o Windows" da bandeja continua sincronizado.

!define AW_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AW_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "${AW_RUN_KEY}" "${PRODUCTNAME}"
  ${If} $0 != ""
    ; Já estava ativado (atualização): só aponta para o executável novo.
    WriteRegStr HKCU "${AW_RUN_KEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${Else}
    ; Instalação silenciosa (/S): não ativa sozinho.
    MessageBox MB_YESNO|MB_ICONQUESTION "Iniciar o ${PRODUCTNAME} junto com o Windows?$\r$\n$\r$\nDá para mudar depois clicando com o botão direito no ícone da bandeja." /SD IDNO IDNO aw_skip_autostart
      WriteRegStr HKCU "${AW_RUN_KEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe"'
      DeleteRegValue HKCU "${AW_APPROVED_KEY}" "${PRODUCTNAME}"
    aw_skip_autostart:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Em atualizações o desinstalador roda com /UPDATE: mantém a escolha.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${AW_RUN_KEY}" "${PRODUCTNAME}"
    DeleteRegValue HKCU "${AW_APPROVED_KEY}" "${PRODUCTNAME}"
  ${EndIf}
!macroend
