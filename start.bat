@echo off
cd /d "C:\Users\Administrator\WorkBuddy\荷泊颖工作空间\herbalinn-tools"

echo ============================================
echo   HERBALINN 运营工具台
echo ============================================

echo [1/2] 清理旧进程...
taskkill /f /im node.exe 2>nul
taskkill /f /im cloudflared.exe 2>nul
ping -n 3 127.0.0.1 >nul

echo [2/2] 启动服务...
start "HERBALINN-Server" /min cmd /c "set NODE_PATH=./node_modules && C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe server.js"
ping -n 3 127.0.0.1 >nul

start "HERBALINN-Tunnel" /min cmd /c "cloudflared.exe tunnel run herbalinn-tools"
ping -n 4 127.0.0.1 >nul

echo.
echo ============================================
echo   启动完成！
echo.
echo   永久地址: https://tools.herbalinn.cn
echo.
echo   把这个链接发给团队成员即可
echo ============================================
echo.
start "" https://tools.herbalinn.cn

pause
