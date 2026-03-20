@echo off

set CERTIFICATE="%~dp0IddSampleDriver.cer"

certutil -addstore -f root %CERTIFICATE%
certutil -addstore -f TrustedPublisher %CERTIFICATE%
pause
