# Third-party assets

## Chess pieces (`pieces.js`)

The piece artwork is the **"Cburnett"** set, created by **Colin M.L. Burnett**. These are SVG images, embedded unmodified as strings except that the fixed width/height and style attributes were removed so the pieces scale with the board.

- Original publication: Wikimedia Commons (e.g. `Chess_klt45.svg`), triple-licensed by the author under **GFDL 1.2+**, **BSD** and **GPL 2+**.
- Copy used here: the `public/piece/cburnett/` directory of the lichess.org source repository (https://github.com/lichess-org/lila), which lists the set as "Colin M.L. Burnett, GPLv2+".

Rift Chess uses these images under the **BSD** option offered by the author:

```
Copyright (c) Colin M.L. Burnett
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the author nor the names of its contributors may
      be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

If you prefer, you may instead treat the pieces as GPL 2+ (as distributed by lichess.org). That choice may affect how you license a combined work.

## Everything else

The rules engine, AI, interface, styles and tests were written for this project and use no third-party libraries. No CDN or external resources are loaded at runtime.
