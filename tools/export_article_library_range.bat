@echo off
setlocal

if "%~2"=="" (
  echo Usage: %~nx0 START END [MODE] [PREFETCH_PID] [ZIP_OUTPUT] [FAILURE_LOG] [SUMMARY_LOG]
  echo Example: %~nx0 2026-01-01 2026-05-31 full
  exit /b 1
)

set "START=%~1"
set "END=%~2"
set "MODE=%~3"
set "PREFETCH_PID=%~4"
set "ZIP_OUTPUT=%~5"
set "FAILURE_LOG=%~6"
set "SUMMARY_LOG=%~7"

if "%MODE%"=="" set "MODE=full"

if "%PREFETCH_PID%"=="" (
  if "%ZIP_OUTPUT%"=="" (
    if "%FAILURE_LOG%"=="" (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --summary-log "%SUMMARY_LOG%"
      )
    ) else (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --failure-log "%FAILURE_LOG%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --failure-log "%FAILURE_LOG%" --summary-log "%SUMMARY_LOG%"
      )
    )
  ) else (
    if "%FAILURE_LOG%"=="" (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --download-zip --zip-output "%ZIP_OUTPUT%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --download-zip --zip-output "%ZIP_OUTPUT%" --summary-log "%SUMMARY_LOG%"
      )
    ) else (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --download-zip --zip-output "%ZIP_OUTPUT%" --failure-log "%FAILURE_LOG%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --download-zip --zip-output "%ZIP_OUTPUT%" --failure-log "%FAILURE_LOG%" --summary-log "%SUMMARY_LOG%"
      )
    )
  )
) else (
  if "%ZIP_OUTPUT%"=="" (
    if "%FAILURE_LOG%"=="" (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID%
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --summary-log "%SUMMARY_LOG%"
      )
    ) else (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --failure-log "%FAILURE_LOG%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --failure-log "%FAILURE_LOG%" --summary-log "%SUMMARY_LOG%"
      )
    )
  ) else (
    if "%FAILURE_LOG%"=="" (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --download-zip --zip-output "%ZIP_OUTPUT%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --download-zip --zip-output "%ZIP_OUTPUT%" --summary-log "%SUMMARY_LOG%"
      )
    ) else (
      if "%SUMMARY_LOG%"=="" (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --download-zip --zip-output "%ZIP_OUTPUT%" --failure-log "%FAILURE_LOG%"
      ) else (
        python "%~dp0export_article_library_range.py" --start "%START%" --end "%END%" --mode "%MODE%" --prefetch-pid %PREFETCH_PID% --download-zip --zip-output "%ZIP_OUTPUT%" --failure-log "%FAILURE_LOG%" --summary-log "%SUMMARY_LOG%"
      )
    )
  )
)

endlocal
