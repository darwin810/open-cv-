# Órbita · OpenCV + Python

Un juego ligero: controla una nave con un objeto de color frente a tu cámara, recoge cristales (+10) y evita meteoritos. Tres impactos terminan la partida. También funciona con ratón, tacto o flechas. P pausa la misión.

## Ejecutar en Windows

Instala Python 3.11 o superior si aún no lo tienes, marcando «Add Python to PATH». En una terminal dentro de esta carpeta:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

Abre **http://127.0.0.1:8000**. Para cerrar el servidor: Ctrl+C. Puedes elegir otro puerto con `app.py --port 8001`.

También puedes abrir `index.html` directamente para jugar en modo manual. La cámara con OpenCV requiere el servidor Python y un navegador moderno (Edge o Chrome).

## Seguimiento

1. Selecciona Cámara y permite su uso.
2. Elige el color de una tapa, tarjeta o papel de color vivo.
3. Pulsa Comenzar misión y mueve el objeto horizontalmente.

La vista está reflejada: mover el objeto hacia tu derecha mueve la nave a tu derecha. Usa buena luz y un fondo distinto del color seleccionado. Se sigue la región más grande de ese color; no se reconoce la anatomía de la mano. Si no se detecta el objeto, la nave mantiene su posición. Puedes cambiar a Manual para apagar la cámara.

## Uso de recursos y privacidad

- OpenCV procesa imágenes JPEG de 160 × 120 con un solo hilo; las peticiones son secuenciales, con una espera de 100 ms entre ellas (máximo aproximado de 10 FPS).
- El juego dibuja a unos 30 FPS y limita la resolución del lienzo en pantallas de alta densidad.
- No usa MediaPipe, redes neuronales, Flask, servicios externos, fuentes ni dependencias web.
- No procesa frames cuando la misión está pausada, finalizada o la pestaña está oculta. La cámara permanece encendida hasta seleccionar Manual o cerrar la página.
- Los frames solo se envían al servidor en 127.0.0.1; no se guardan. El récord se guarda en localStorage.
- El consumo real depende del equipo y del navegador; no se ha medido un presupuesto de CPU/RAM.

Archivos: `app.py` sirve la interfaz y calcula el centro del color usando HSV y contornos; `index.html` contiene toda la interfaz y la lógica del juego.
