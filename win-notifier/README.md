# @focus.matters/win-notifier

Servicio residente de Windows que recibe `POST` con JSON `{ "title", "body" }` y los presenta como avisos apilados en la bandeja del sistema.

## Instalación con UPM

```powershell
upm install @focus.matters/win-notifier
```

Seleccione el binario y el hook `codex-stop-notification`. Al finalizar, UPM:

- copia `WinNotifier.exe` a `.upm/bin`;
- instala el hook Stop en el directorio global de Codex;
- fusiona el handler en `~/.codex/hooks.json` sin eliminar otros hooks;
- inicia la versión instalada del servicio.

El hook envía el último mensaje del asistente a WinNotifier con el título `Tarea completada`. Si existe una ventana de VS Code cuyo workspace corresponde al `cwd` del hook, hacer clic en el aviso la trae al frente.

## Desarrollo

El código WinForms y el manifiesto de DPI están en `src`. Para regenerar el binario distribuido en Windows:

```powershell
npm run build
```
