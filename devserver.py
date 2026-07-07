#!/usr/bin/env python3
# 開発用サーバー：常に最新ファイルを返すため no-cache ヘッダを付ける。
# 本番(GitHub Pages)ではこのファイルは使わない。
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8741
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    import functools
    handler = functools.partial(NoCacheHandler, directory=directory)
    ThreadingHTTPServer(('0.0.0.0', port), handler).serve_forever()
