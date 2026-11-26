# Mi Música · reproductor local para iPhone (PWA)

Reproductor de música sin servidor, sin dependencias y sin compilación. Los audios se leen en el propio iPhone y **nunca se suben a ningún sitio**.

## 1. Subir a un repositorio nuevo de GitHub

Descomprime el ZIP de modo que `index.html` quede en
`C:\Users\diego\AndroidStudioProjects\music-player-ios\index.html`.

1. Entra en <https://github.com/new>.
2. **Repository name:** `music-player-ios`. Elige **Public** (con cuenta gratuita, Pages requiere repositorio público).
3. **No** marques README, .gitignore ni licencia. Pulsa **Create repository**.
4. Abre PowerShell y ejecuta, línea por línea (cambia `TU_USUARIO`):

```powershell
cd C:\Users\diego\AndroidStudioProjects\music-player-ios
git init
git add .
git status
git commit -m "Reproductor de musica PWA"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/music-player-ios.git
git push -u origin main
```

En `git status` comprueba que aparece `.github/workflows/deploy.yml` y que no hay archivos ajenos al proyecto. Si Git pide identidad: `git config user.name "Tu nombre"` y `git config user.email "tu@correo"`.

## 2. Activar GitHub Pages

1. En el repositorio: **Settings → Pages**.
2. En **Build and deployment → Source** elige **GitHub Actions**.
3. Ve a **Actions → Publicar en GitHub Pages**. El primer push se ejecuta antes de activar Pages y puede salir en rojo: pulsa **Re-run all jobs** (o **Run workflow**).
4. Cuando esté en verde, tu app estará en `https://TU_USUARIO.github.io/music-player-ios/`.

Cada `git push` a `main` ejecuta las pruebas y publica automáticamente:

```powershell
git add .
git commit -m "Describe el cambio"
git push
```

## 3. Añadir a la pantalla de inicio del iPhone

1. Abre la dirección en **Safari**.
2. Pulsa **Compartir** (cuadrado con flecha; en algunas versiones de iOS está dentro del botón **•••**).
3. Elige **Añadir a pantalla de inicio**. Si aparece **Abrir como app web**, déjalo activado.
4. Pulsa **Añadir** y abre **Mi Música** desde su icono.

> La app instalada guarda sus datos aparte de Safari. Instálala primero y configura tus canciones dentro de ella.

## Uso

| Quiero… | Cómo |
|---|---|
| Cargar música | Botón **+** → **Seleccionar archivos** → marca varias canciones en Archivos |
| Marcar favorita | Corazón de la fila o del reproductor |
| Reordenar | **Ordenar** (flechas o arrastrar ≡), o menú **•••** de la canción |
| Sonar desde una canción hasta el final y volver al principio | **•••** → **Reproducir desde aquí en secuencia** |
| Repetición | Botón de repetir: desactivada → lista → canción |
| Guardar configuración | Configuración → **Exportar** → **Guardar en Archivos** |
| Restaurarla | Configuración → **Importar**, y luego carga los audios (o al revés) |

### Qué se guarda y qué no

- Orden, favoritas, repetición, aleatorio, última pista y posición, títulos y carátulas: se guardan solos (`localStorage` + IndexedDB).
- **Los archivos de audio no se guardan.** Al cerrar la app hay que volver a elegirlos; la configuración se aplica sola.
- Las canciones se reconocen por **nombre de archivo y tamaño**. Si solo cambia el tamaño, se reconocen por el nombre cuando no hay duplicados. Si renombras un archivo, cuenta como nuevo.
- La posición exacta se restaura al cargar los audios, en pausa: pulsa ▶︎.

## Particularidades de iOS

| Tema | Comportamiento |
|---|---|
| Espectro **Automático** (iPhone) | El audio suena por HTML5 Audio y el espectro se calcula decodificando el archivo aparte. Está pensado para no interrumpir la reproducción en segundo plano. Se omite en archivos de más de 40 MB o 15 minutos. |
| Espectro **En vivo** | `AnalyserNode` sobre el audio real y volumen desde la app. iOS puede silenciarlo al bloquear la pantalla. |
| Volumen | Safari no permite cambiarlo en un `<audio>`. En modo Automático usa los botones físicos; el control de la app funciona en modo En vivo y en ordenador. |
| Pantalla bloqueada | iOS muestra **anterior/siguiente** o **saltos**, no ambos. Se elige en Configuración; la duración del salto es orientativa para iOS. |
| Formatos | MP3, M4A/AAC, WAV, AIFF y FLAC. OGG/Opus dependen de la versión de iOS. |
| Apple Music | Las canciones con DRM no se pueden cargar. Usa archivos que estén en la app Archivos. |

## Desarrollo local

Los módulos de JavaScript no funcionan abriendo el archivo con doble clic; hace falta un servidor:

```powershell
cd C:\Users\diego\AndroidStudioProjects\music-player-ios
py -m http.server 8080
```

Abre <http://localhost:8080>. Pruebas (Node 22): `npm test`.

Si cambias la lista de archivos de la app, actualiza `ASSETS` en `sw.js` y sube el número de `CACHE`.

## Estructura

```
index.html · manifest.webmanifest · sw.js
css/styles.css
js/app.js          interfaz y coordinación
js/player.js       audio y Media Session
js/visualizer.js   espectro (fft.js)
js/queue.js        aleatorio y repetición
js/library.js      playlist-config.json
js/metadata.js     etiquetas ID3 / MP4 / FLAC
js/storage.js      localStorage e IndexedDB
tests/             pruebas de la lógica
.github/workflows/deploy.yml
```
