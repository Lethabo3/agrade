Section "Install Virtual Display Driver" SecDriver
  CreateDirectory "C:\IddSampleDriver"
  SetOutPath "C:\IddSampleDriver"
  File "/oname=option.txt" "$INSTDIR\resources\drivers\option.txt"
  SetOutPath "$INSTDIR\resources\drivers"
  File "$INSTDIR\resources\drivers\iddsampledriver.inf"
  File "$INSTDIR\resources\drivers\iddsampledriver.cat"
  File "$INSTDIR\resources\drivers\iddsampledriver.dll"
  File "$INSTDIR\resources\drivers\iddsampledriver.cer"
  ExecWait '"$SYSDIR\certutil.exe" -addstore -f root "$INSTDIR\resources\drivers\iddsampledriver.cer"'
  ExecWait '"$SYSDIR\certutil.exe" -addstore -f TrustedPublisher "$INSTDIR\resources\drivers\iddsampledriver.cer"'
  ExecWait '"$SYSDIR\pnputil.exe" /add-driver "$INSTDIR\resources\drivers\iddsampledriver.inf" /install'
SectionEnd
