# Third-party notices

## TierNote agent and messaging integration

Coffee CLI's built-in agent and private messaging channels adapt code from the
TierNote sister project. TierNote's current code is licensed under
AGPL-3.0-or-later. Applicable source notices and licensing remain in effect.

## Tencent openclaw-weixin

The Weixin channel adapts the HTTP/JSON protocol and transport design published
in Tencent's `openclaw-weixin` project.

Copyright (C) 2026 Tencent. All rights reserved.

Licensed under the MIT License:
https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

Coffee CLI independently implements the messaging transport and does not
bundle or require the OpenClaw runtime. The source-code license does not
replace the messaging service's authorization or usage terms.

## Windows console runtime

Windows x64 installers include the unmodified `conpty.dll` and `OpenConsole.exe`
from Microsoft's `Microsoft.Windows.Console.ConPTY` package, version
1.24.261001001. The runtime is licensed under the MIT License.

Copyright (c) Microsoft Corporation. All rights reserved.

The full license is included beside the application as `CONPTY-LICENSE.txt`.
Source: https://github.com/microsoft/terminal
Package: https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY/1.24.261001001

## Desktop control helper

The embedded Windows desktop-control helper includes MIT-licensed code.

Copyright (c) 2026 Lovecast Inc.

The complete license is in `licenses/computer-use-windows.txt` and is extracted
beside the helper when it runs.

## Optional browser control runtime

Browser control downloads the unmodified `agent-browser` v0.39.4 runtime on
demand. It is licensed under Apache-2.0. The complete license is in
`licenses/agent-browser.txt` and is saved beside the downloaded runtime.

Source: https://github.com/vercel-labs/agent-browser

## Service names

Weixin, WeChat, and Telegram are trademarks of their respective owners. Their
names identify optional messaging integrations; Coffee CLI is not endorsed by
either service.
