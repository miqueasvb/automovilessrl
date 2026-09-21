const RUTA_JSON = "data/vehiculos.json";
const CARPETA_FOTOS = "img/vehiculos";

// --- Validación de rutas: solo se puede tocar contenido dentro de
// img/vehiculos/<id>/, nunca fuera de esa carpeta. Sin esto, alguien que
// consiguiera (o adivinara) la contraseña del panel podría, por ejemplo,
// pedir borrar o pisar "../../netlify/functions/admin-api.js" o cualquier
// otro archivo del repo, mandando un "id" o "nombreArchivo" armado a
// propósito. Estas funciones cortan eso de raíz: solo se permiten letras,
// números, guiones y puntos — nada de "/" ni "..".
function esSegmentoSeguro(valor) {
    return typeof valor === "string" && valor.length > 0 && /^[a-zA-Z0-9._-]+$/.test(valor) && !valor.includes("..");
}

// Para "path" (que ya viene con la carpeta incluida, ej: img/vehiculos/xxx/foto.jpg):
// exige que arranque con la carpeta de fotos y que cada segmento sea seguro.
function esPathDeFotoSeguro(path) {
    if (typeof path !== "string" || !path.startsWith(CARPETA_FOTOS + "/")) return false;
    const resto = path.slice((CARPETA_FOTOS + "/").length);
    const segmentos = resto.split("/");
    if (segmentos.length !== 2) return false; // exactamente <id>/<archivo>
    return segmentos.every(esSegmentoSeguro);
}

const crypto = require("crypto");
function igual(a, b) {
    const x = crypto.createHash("sha256").update(String(a ?? "")).digest();
    const y = crypto.createHash("sha256").update(String(b ?? "")).digest();
    return crypto.timingSafeEqual(x, y);
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return respuesta(405, { error: "Método no permitido" });
    }

    let body;
    try {
        body = JSON.parse(event.body || "{}");
    } catch (e) {
        return respuesta(400, { error: "Cuerpo de la petición inválido" });
    }

    const { ADMIN_USER, ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = process.env;

    if (!ADMIN_USER || !ADMIN_PASSWORD || !GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        return respuesta(500, { error: "El panel todavía no está configurado del lado del servidor (faltan variables de entorno en Netlify)." });
    }

    if (!igual(body.usuario, ADMIN_USER) || !igual(body.password, ADMIN_PASSWORD)) {
        return respuesta(401, { error: "Usuario o contraseña incorrectos." });
    }

    const branch = GITHUB_BRANCH || "main";
    const ghHeaders = {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    };
    const ghBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

    try {
        switch (body.accion) {

            case "listar": {
                const r = await fetch(`${ghBase}/${RUTA_JSON}?ref=${branch}`, { headers: ghHeaders });
                if (r.status === 404) {
                    return respuesta(200, { vehiculos: [], sha: null });
                }
                if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    return respuesta(r.status, { error: e.message || "No se pudo leer el catálogo" });
                }
                const data = await r.json();
                const contenido = Buffer.from(data.content, "base64").toString("utf-8");
                return respuesta(200, { vehiculos: JSON.parse(contenido), sha: data.sha });
            }

            case "subirFoto": {
                const { id, nombreArchivo, base64 } = body;
                if (!id || !nombreArchivo || !base64) {
                    return respuesta(400, { error: "Faltan datos para subir la foto." });
                }
                if (!esSegmentoSeguro(id) || !esSegmentoSeguro(nombreArchivo)) {
                    return respuesta(400, { error: "El id o el nombre de archivo tienen caracteres no permitidos." });
                }
                const path = `${CARPETA_FOTOS}/${id}/${nombreArchivo}`;
                const r = await fetch(`${ghBase}/${path}`, {
                    method: "PUT",
                    headers: ghHeaders,
                    body: JSON.stringify({
                        message: `Agregar foto (${id})`,
                        content: base64,
                        branch
                    })
                });
                if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    return respuesta(r.status, { error: e.message || "Error subiendo la foto" });
                }
                return respuesta(200, { path });
            }

            case "guardarJson": {
                const { vehiculos, sha, mensaje } = body;
                if (!Array.isArray(vehiculos)) {
                    return respuesta(400, { error: "Formato de catálogo inválido." });
                }
                const contenido = Buffer.from(JSON.stringify(vehiculos, null, 2), "utf-8").toString("base64");
                const put = { message: mensaje || "Actualizar catálogo", content: contenido, branch };
                if (sha) put.sha = sha;

                const r = await fetch(`${ghBase}/${RUTA_JSON}`, {
                    method: "PUT",
                    headers: ghHeaders,
                    body: JSON.stringify(put)
                });
                if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    return respuesta(r.status, { error: e.message || "No se pudo guardar el catálogo" });
                }
                const data = await r.json();

                // El catálogo (vehiculos.json) ya quedó guardado, que es lo más
                // importante. Ahora, de yapa, regeneramos sitemap.xml con la
                // lista actual de vehículos, para que cada alta/baja del panel
                // también se refleje ahí automáticamente y no haya que tocarlo
                // a mano nunca más. Si esto llegara a fallar por algún motivo,
                // no lo tratamos como error grave: el catálogo ya se guardó bien,
                // el sitemap es una mejora aparte.
                try {
                    const sitio = (process.env.SITE_URL || `https://${event.headers.host}`).replace(/\/+$/, "");
                    await actualizarSitemap(vehiculos, ghHeaders, ghBase, branch, sitio);
                } catch (e) {
                    console.error("No se pudo actualizar el sitemap:", e.message);
                }

                return respuesta(200, { sha: data.content.sha });
            }

            case "eliminarFotos": {
                // Borra TODAS las fotos de un vehículo (se usa al eliminar el
                // vehículo completo desde el panel).
                const { id } = body;
                if (!id) return respuesta(400, { error: "Falta el id del vehículo." });
                if (!esSegmentoSeguro(id)) {
                    return respuesta(400, { error: "El id tiene caracteres no permitidos." });
                }

                const carpeta = `${CARPETA_FOTOS}/${id}`;
                const listR = await fetch(`${ghBase}/${carpeta}?ref=${branch}`, { headers: ghHeaders });

                if (listR.status === 404) {
                    // Este vehículo no tenía fotos propias (o ya se habían borrado antes). No es un error.
                    return respuesta(200, { borradas: 0 });
                }
                if (!listR.ok) {
                    const e = await listR.json().catch(() => ({}));
                    return respuesta(listR.status, { error: e.message || "No se pudo leer la carpeta de fotos" });
                }

                const archivos = await listR.json();
                let borradas = 0;
                const errores = [];

                // GitHub no tiene un "borrar carpeta entera" — hay que borrar
                // archivo por archivo, cada uno con su propio commit. Si alguna
                // foto puntual falla, seguimos con las demás en vez de frenar
                // todo (ya el catálogo se guardó bien antes de llegar acá).
                // Además, chequeamos que cada archivo listado siga dentro de
                // la carpeta esperada (por más que esto ya lo controla GitHub,
                // es una segunda capa de seguridad sin costo).
                for (const archivo of archivos) {
                    if (archivo.type !== "file") continue;
                    if (!archivo.path.startsWith(carpeta + "/")) continue;
                    const delR = await fetch(`${ghBase}/${archivo.path}`, {
                        method: "DELETE",
                        headers: ghHeaders,
                        body: JSON.stringify({
                            message: `Eliminar foto (${id})`,
                            sha: archivo.sha,
                            branch
                        })
                    });
                    if (delR.ok) {
                        borradas++;
                    } else {
                        errores.push(archivo.path);
                    }
                }

                return respuesta(200, { borradas, errores });
            }

            case "eliminarFoto": {
                // Borra UNA foto puntual por su ruta exacta. Se usa cuando se
                // edita un vehículo y se saca o reemplaza alguna foto suelta
                // (no todo el vehículo) — para que esa foto vieja no quede
                // huérfana en GitHub.
                const { path } = body;
                if (!path) return respuesta(400, { error: "Falta el path de la foto." });
                if (!esPathDeFotoSeguro(path)) {
                    return respuesta(400, { error: "La ruta de la foto no es válida." });
                }

                const getR = await fetch(`${ghBase}/${path}?ref=${branch}`, { headers: ghHeaders });
                if (getR.status === 404) {
                    return respuesta(200, { borrada: false }); // ya no existía, no es error
                }
                if (!getR.ok) {
                    const e = await getR.json().catch(() => ({}));
                    return respuesta(getR.status, { error: e.message || "No se pudo leer la foto" });
                }
                const info = await getR.json();

                const delR = await fetch(`${ghBase}/${path}`, {
                    method: "DELETE",
                    headers: ghHeaders,
                    body: JSON.stringify({ message: `Eliminar foto: ${path}`, sha: info.sha, branch })
                });
                if (!delR.ok) {
                    const e = await delR.json().catch(() => ({}));
                    return respuesta(delR.status, { error: e.message || "No se pudo borrar la foto" });
                }
                return respuesta(200, { borrada: true });
            }

            default:
                return respuesta(400, { error: "Acción desconocida." });
        }
    } catch (e) {
        return respuesta(500, { error: "Error inesperado: " + e.message });
    }
};

function respuesta(statusCode, objeto) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(objeto)
    };
}


// Reconstruye sitemap.xml completo: las páginas fijas del sitio + una entrada
// por cada vehículo que exista HOY en el catálogo. Así, cuando se agrega un
// vehículo aparece automáticamente, y cuando se elimina, desaparece del
// sitemap en el mismo commit — sin tocar nada a mano.
async function actualizarSitemap(vehiculos, ghHeaders, ghBase, branch, SITIO) {
    const paginasFijas = [
        { loc: `${SITIO}/`, changefreq: "daily", priority: "1.0" },
        { loc: `${SITIO}/catalogo.html`, changefreq: "daily", priority: "0.9" },
        { loc: `${SITIO}/nosotros.html`, changefreq: "monthly", priority: "0.6" },
        { loc: `${SITIO}/clientes.html`, changefreq: "monthly", priority: "0.6" }
    ];
    const paginasVehiculos = vehiculos
        .filter(v => v && v.id)
        .map(v => ({
            loc: `${SITIO}/${encodeURIComponent(v.id)}`,
            changefreq: "weekly",
            priority: "0.8"
        }));

    const todas = paginasFijas.concat(paginasVehiculos);
    const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        todas.map(u =>
            `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
        ).join("\n") +
        '\n</urlset>\n';

    // Necesitamos el sha actual de sitemap.xml para poder sobreescribirlo
    // (así funciona la API de contenidos de GitHub).
    const getR = await fetch(`${ghBase}/sitemap.xml?ref=${branch}`, { headers: ghHeaders });
    const shaActual = getR.ok ? (await getR.json()).sha : undefined;

    const put = {
        message: "Actualizar sitemap.xml (automático desde el panel)",
        content: Buffer.from(xml, "utf-8").toString("base64"),
        branch
    };
    if (shaActual) put.sha = shaActual;

    const putR = await fetch(`${ghBase}/sitemap.xml`, {
        method: "PUT",
        headers: ghHeaders,
        body: JSON.stringify(put)
    });
    if (!putR.ok) {
        const e = await putR.json().catch(() => ({}));
        throw new Error(e.message || "No se pudo actualizar sitemap.xml");
    }
}
