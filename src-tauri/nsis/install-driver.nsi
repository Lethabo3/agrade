Section "Install Virtual Display Driver"
  SetOutPath "$INSTDIR\drivers"
  File "drivers\iddsampledriver.inf"
  File "drivers\iddsampledriver.cat"
  File "drivers\iddsampledriver.dll"
  File "drivers\installCert.bat"
  
  ExecWait '"$SYSDIR\pnputil.exe" /add-driver "$INSTDIR\drivers\iddsampledriver.inf" /install' $0
  DetailPrint "Driver install exit code: $0"
SectionEnd
