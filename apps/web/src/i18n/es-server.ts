/**
 * Spanish (Mexico) for the error messages the API sends (`{ error: { message } }`) and the import
 * row problems it reports, which the app shows through `t(error.message)`. Keyed by the server's
 * English text; a message not listed here is shown in English.
 */
export const esServer: Readonly<Record<string, string>> = {
  "A company can't be merged into itself.": "Una empresa no se puede unir consigo misma.",
  "A reason only goes with a dismissed lead.": "Un motivo solo aplica a una vacante descartada.",
  "A scheduled interview needs a start time.": "Una entrevista agendada necesita hora de inicio.",
  "A search is already running.": "Ya hay una búsqueda en curso.",
  "Attach the CSV in the file field.": "Adjunta el CSV en el campo del archivo.",
  "Attach the CV in the file field.": "Adjunta el CV en el campo del archivo.",
  "Enter a company name.": "Escribe el nombre de una empresa.",
  "Gmail is not connected.": "Gmail no está conectado.",
  "No such application to merge into.": "No existe la postulación con la que quieres unir.",
  "No such application.": "No existe esa postulación.",
  "No such company.": "No existe esa empresa.",
  "No such event.": "No existe ese evento.",
  "No such interview.": "No existe esa entrevista.",
  "No such lead.": "No existe esa vacante.",
  "Not found.": "No se encontró.",
  "Offerbound couldn't find a header row with Company, Role and Status.":
    "Offerbound no encontró una fila de encabezados con Company, Role y Status.",
  "Paste the report text.": "Pega el texto del reporte.",
  "Pick a different application to merge into.": "Elige otra postulación con la cual unir.",
  "Pick a different company to merge into.": "Elige otra empresa con la cual unir.",
  "Send the CSV as multipart form data.": "Envía el CSV como formulario multipart.",
  "Send the CV as multipart form data.": "Envía el CV como formulario multipart.",
  "Sign in to continue.": "Inicia sesión para continuar.",
  "Some of the selected rows are not in this preview.":
    "Algunas de las filas elegidas no están en esta vista previa.",
  "Something went wrong.": "Algo salió mal.",
  "Syncing has already started.": "La sincronización ya empezó.",
  "Syncing has not been started.": "La sincronización no ha empezado.",
  "That posting is already in Offerbound.": "Esa vacante ya está en Offerbound.",
  "The cursor is not valid.": "El cursor no es válido.",
  "The demo is read-only for anything you type. Status changes, shortlisting and undo work.":
    "La demo es de solo lectura para todo lo que escribas. Cambiar estados, preseleccionar y deshacer sí funcionan.",
  "The demo mailbox is not available.": "El buzón de la demo no está disponible.",
  "The interview can't end before it starts.": "La entrevista no puede terminar antes de empezar.",
  "The profile could not be generated. Try again.":
    "No se pudo generar el perfil. Inténtalo de nuevo.",
  "The report could not be read. Try again.": "No se pudo leer el reporte. Inténtalo de nuevo.",
  "The request is too large.": "La solicitud es demasiado grande.",
  "The service is not ready.": "El servicio no está listo.",
  "This change can't be undone.": "Este cambio no se puede deshacer.",
  "This change was already undone.": "Este cambio ya se deshizo.",
  "This file has no readable text. Try another file.":
    "Este archivo no tiene texto legible. Prueba con otro archivo.",
  "This preview has expired. Add the file again.":
    "Esta vista previa expiró. Agrega el archivo de nuevo.",
  "This preview has expired. Paste the report again.":
    "Esta vista previa expiró. Pega el reporte de nuevo.",
  "This report is too long. Paste a shorter one.":
    "Este reporte es demasiado largo. Pega uno más corto.",
  "Too many requests.": "Demasiadas solicitudes.",
  "Upload a CV first.": "Sube un CV primero.",
  "Upload a PDF or Word (.docx) file.": "Sube un archivo PDF o Word (.docx).",
  "Use Reconsider for a suppressed lead.": "Usa Reconsiderar para una vacante apartada.",
  "Your CV was replaced. Check the new one.": "Tu CV se reemplazó. Revisa el nuevo.",
  // Rows of a sheet import.
  "The file could not be read as CSV.": "El archivo no se pudo leer como CSV.",
  "The row could not be read.": "No se pudo leer la fila.",
  "Company is missing.": "Falta la empresa.",
  "Role is missing.": "Falta el puesto.",
  "Status is missing.": "Falta el estado.",
};

/** Server messages with a value in them, as patterns. */
export const esServerPatterns: readonly [RegExp, string][] = [
  [
    /^Status "(.*)" isn't one Offerbound imports\.$/,
    'El estado "$1" no es uno de los que Offerbound importa.',
  ],
  [
    /^Date applied "(.*)" isn't in the YYYY-MM-DD format\.$/,
    'La fecha de postulación "$1" no tiene el formato AAAA-MM-DD.',
  ],
  [
    /^Too many requests\. Try again in (.+)\.$/,
    "Demasiadas solicitudes. Inténtalo de nuevo en $1.",
  ],
];
