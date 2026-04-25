# pi-doc-tools

Extensión ligera de pi para extraer texto de documentos locales. No usa LiteParse ni LibreOffice; se apoya en herramientas CLI de Termux y librerías JS puras.

## Formatos soportados

| Formato | Método |
|---------|--------|
| PDF | `pdftotext` (poppler). Si no tiene texto, fallback OCR vía `pdftoppm` + `tesseract` (hasta N págs configurables) |
| Imágenes (PNG, JPG, WEBP, GIF, BMP, TIFF) | `tesseract` OCR |
| DOCX | `mammoth` (JS puro) |
| XLSX / XLS | `xlsx` (SheetJS, JS puro) |
| PPTX | `pptx-text-parser` (JS puro) |
| CSV, TXT, MD, JSON, etc. | Lectura directa |

## Requisitos del sistema

```bash
pkg install poppler tesseract
```

Tesseract trae el idioma `eng` por defecto en Termux.

## Configuración

Editá `config.json` (en la misma carpeta de esta extensión) para ajustar límites:

```json
{
  "maxChars": 150000,
  "maxPdfOcrPages": 10
}
```

- `maxChars`: máximo de caracteres devueltos. Si se supera, avisa cuánto se omitió.
- `maxPdfOcrPages`: máximo de páginas a procesar vía OCR en PDFs escaneados. Si el PDF tiene más, avisa el total y cuántas procesó.

## Instalación en pi

```bash
pi install /data/data/com.termux/files/home/workspace/scripts/pi-doc-tools
```

Luego `/reload` en pi para cargarla.

## Uso

La extensión registra la herramienta `parse_document`. El modelo la invoca automáticamente cuando le pedís procesar un archivo, o podés forzarla:

```
parse_document({ "path": "./contrato.pdf" })
parse_document({ "path": "./factura.jpg", "ocr": true })
parse_document({ "path": "./datos.xlsx" })
```

## Comportamiento ante límites

- **Texto muy largo**: trunca al máximo configurado y agrega un aviso con el total original.
- **PDF con muchas páginas escaneadas**: procesa hasta el límite configurado y avisa cuántas páginas tiene en total.

## Independencia

- Cero dependencias nativas de Node (no hay compilación de C++).
- No depende del proveedor de IA ni de sus capacidades de visión.
- Corre localmente en el dispositivo Android.
