# Piso – tareas compartidas y agenda (PWA con Firebase)

## 1. Firebase (gratis, plan Spark)
1. console.firebase.google.com → Crear proyecto.
2. Build → Authentication → Método de acceso → activa "Correo y contraseña".
3. Build → Firestore Database → Crear base de datos (modo producción). Pestaña Reglas → pega el contenido de `firestore.rules` → Publicar.
4. Configuración del proyecto → Tus apps → Web (</>) → copia la config y pégala en `firebase-config.js`.

## 2. Publicar (hosting gratis con HTTPS)
    npm i -g firebase-tools
    firebase login
    firebase init hosting     # carpeta pública: .  | single-page: No
    firebase deploy
Te dará una URL tipo `https://tu-proyecto.web.app`.

## 3. Instalar en iPhone
Abre la URL en Safari → Compartir → "Añadir a pantalla de inicio".

## Probar en local
    npx serve .      (o: python3 -m http.server)
