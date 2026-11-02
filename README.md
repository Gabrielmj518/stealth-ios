# Stealth para iPhone

App de iPhone con la misma interfaz que Stealth para Windows. Cambia la ubicación **desde el propio iPhone**, sin PC conectado, usando LocalDevVPN y un archivo de emparejamiento.

> Esta app se compila en la nube (GitHub) porque Windows no puede compilar apps de iPhone.

## 1. Subir el proyecto a GitHub
1. Crea una cuenta gratis en github.com (si no tienes).
2. Arriba a la derecha: **+ → New repository**. Nombre: `stealth-ios`. Elige **Public** (así el `.exe` puede descargar la app sin iniciar sesión y las compilaciones son gratis). Pulsa **Create repository**.
3. En la página del repositorio pulsa **uploading an existing file**.
4. Abre la carpeta del proyecto (la que contiene `project.yml`) y **arrastra TODO su contenido** a la página: las carpetas `Stealth`, `Vendor`, `.github` y los archivos sueltos. Espera a que termine de cargar y pulsa **Commit changes**.
   - Si la carpeta `.github` no se sube: pulsa **Add file → Create new file**, escribe el nombre `.github/workflows/build-ios.yml` y pega dentro el contenido del archivo `build-ios.yml` de esa carpeta.

## 2. Compilar la app
1. Entra en la pestaña **Actions** del repositorio. Si pide activarlas, acepta.
2. A la izquierda elige **Build iOS app** → **Run workflow** → **Run workflow**.
3. Espera unos 10 a 20 minutos. Cuando salga una palomita verde, terminó.
4. Si sale una **X roja**: entra en esa ejecución y mándame una captura de la pantalla (y descarga el archivo `build-log` de abajo si existe). Con eso la arreglo.

## 3. Instalar en el iPhone
1. En **Stealth para Windows** → icono del teléfono con flecha → pega `tu-usuario/stealth-ios` → **Download**. Se guarda `Stealth.ipa` en Descargas.
2. Instálalo con **iloader** (inicias sesión con tu Apple ID y se instala por USB).
3. En el iPhone: **Ajustes → General → VPN y gestión de dispositivos** → confía en tu Apple ID.

## 4. Primer uso en el iPhone
1. **Modo Desarrollador** activado (Ajustes → Privacidad y seguridad) y reiniciar.
2. Instala y activa **LocalDevVPN** (App Store).
3. En Stealth, toca el nombre del iPhone (arriba a la izquierda) → **Import** y elige el archivo de emparejamiento **RPPairing** creado con `idevice_pair` en el PC. Una sola vez.
4. Cierra el panel, toca el mapa → **Teleport here**. El primer intento conviene hacerlo con Wi-Fi.

## Límites conocidos
* Mantén la app abierta durante una **ruta**: las rutas las calcula la interfaz y se detienen si la app pasa a segundo plano. El teletransporte simple sí se mantiene.
* Con un Apple ID gratuito la app caduca a los 7 días.
