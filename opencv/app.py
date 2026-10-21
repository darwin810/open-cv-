"""Local OpenCV color tracker. Run: python app.py"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

cv2.setNumThreads(1)
ROOT = Path(__file__).resolve().parent


def track(data, hue):
    frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError('Imagen no válida')
    frame = cv2.resize(frame, (160, 120))
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # Circular hue distance also handles red at the 0/179 boundary.
    delta = np.abs(hsv[:, :, 0].astype(np.int16) - hue)
    mask = ((np.minimum(delta, 180 - delta) < 14) &
            (hsv[:, :, 1] > 85) & (hsv[:, :, 2] > 65)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {'found': False}
    contour = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(contour)
    if area < 35:
        return {'found': False}
    m = cv2.moments(contour)
    return {'found': True, 'x': 1 - m['m10'] / m['m00'] / 160,
            'y': m['m01'] / m['m00'] / 120, 'area': round(area)}


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, content, kind='application/json'):
        body = content if isinstance(content, bytes) else json.dumps(content).encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            self.reply(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        elif self.path == '/health':
            self.reply(200, {'ok': True, 'opencv': cv2.__version__})
        else:
            self.reply(404, {'error': 'No encontrado'})

    def do_POST(self):
        if self.path != '/track':
            self.reply(404, {'error': 'No encontrado'})
            return
        # Browser frames stay on localhost; reject cross-origin requests.
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            self.reply(403, {'error': 'Origen no permitido'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            hue = int(self.headers.get('X-Hue', '60'))
            if not 0 < length <= 100000 or not 0 <= hue <= 179:
                raise ValueError('Parámetros fuera de rango')
            self.reply(200, track(self.rfile.read(length), hue))
        except (ValueError, cv2.error) as exc:
            self.reply(400, {'error': str(exc)})

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Órbita lista en http://127.0.0.1:{args.port} — Ctrl+C para salir', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
