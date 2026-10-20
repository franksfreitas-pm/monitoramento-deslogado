const https = require('https');
const fs = require('fs');
const path = require('path');

const username = 'Antigravity.30ed2c.mp-service-account';
const password = 'f69cyHSkAVg1US2dhcWNILTgM853VuLv';
const projectId = '3387295';
const auth = Buffer.from(username + ':' + password).toString('base64');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Utilitário para chamadas na API do Mixpanel com retry
async function fetchMixpanel(endpoint, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await new Promise((resolve, reject) => {
                https.get({
                    hostname: 'mixpanel.com',
                    path: endpoint,
                    headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
                }, res => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(body);
                            if (json.error) {
                                reject(new Error(json.error));
                            } else {
                                resolve(json);
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                }).on('error', reject);
            });
            return data;
        } catch (e) {
            console.error(`Erro na requisição (tentativa ${i + 1}): ${e.message}`);
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Verifica se uma data YYYY-MM-DD cai no sábado (6) ou domingo (0)
function isWeekend(dateStr) {
    const day = new Date(dateStr + "T12:00:00Z").getUTCDay();
    return day === 0 || day === 6;
}

// Retorna lista ordenada de datas YYYY-MM-DD contendo apenas dias úteis (segunda a sexta)
function getWeekdaysList(startStr, endStr) {
    if (endStr < startStr) return [];
    const list = [];
    let cur = new Date(startStr + "T12:00:00Z");
    const end = new Date(endStr + "T12:00:00Z");
    while (cur <= end) {
        const day = cur.getUTCDay();
        if (day !== 0 && day !== 6) {
            list.push(cur.toISOString().split("T")[0]);
        }
        cur = new Date(cur.getTime() + 86400000);
    }
    return list;
}

// Conta quantos dias úteis (segunda a sexta) existem no intervalo [startStr, endStr]
function countWeekdays(startStr, endStr) {
    return getWeekdaysList(startStr, endStr).length;
}

// Configuração de datas em Horário de Brasília (UTC-3)
const brtNowMs = Date.now() - (3 * 60 * 60 * 1000);
const todayObj = new Date(brtNowMs);
const todayStr = todayObj.toISOString().split("T")[0];
const yesterdayObj = new Date(brtNowMs - 86400000);
const yesterdayStr = yesterdayObj.toISOString().split("T")[0];

// Janelas de Baseline (Dias Úteis até 13/10)
const b90Start = "2026-07-16";
const b30Start = "2026-09-14";
const bEnd = "2026-10-13";
const b30Dates = getWeekdaysList(b30Start, bEnd); // 22 dias úteis
const b30Weekdays = Math.max(1, b30Dates.length);
const b90Weekdays = Math.max(1, countWeekdays(b90Start, bEnd)); // 64 dias úteis

// Janelas Pós-Lançamento (a partir de 15/10, apenas dias úteis)
const fetchStart = "2026-10-15";
const fetchEndToday = todayStr < fetchStart ? fetchStart : todayStr;
const kpiEnd = yesterdayStr < fetchStart ? fetchStart : yesterdayStr;
const kpiDates = getWeekdaysList(fetchStart, kpiEnd);
const kpiWeekdays = Math.max(1, kpiDates.length);

// Busca série diária de um evento e retorna somas e séries diárias filtradas apenas para DIAS ÚTEIS
async function fetchEventSeries(event, fromDate, property = "time", filterPropValue = null) {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=${event}&name=${property}&type=general&unit=day&from_date=${fromDate}&to_date=${fetchEndToday}`;
    const result = await fetchMixpanel(url);

    let sum30 = 0;
    let sum90 = 0;
    let sumKpi = 0;
    let sumRealtime = 0;
    const dailyMap = {};

    if (!result || !result.data || !result.data.values) {
        return {
            sum30, sum90, sumKpi, sumRealtime,
            kpiAvg: 0, b30Avg: 0, b90Avg: 0,
            series30: b30Dates.map(d => ({ date: d, value: 0 })),
            seriesCurrent: kpiDates.map(d => ({ date: d, value: 0 }))
        };
    }

    const entries = filterPropValue
        ? (result.data.values[filterPropValue] ? [[filterPropValue, result.data.values[filterPropValue]]] : [])
        : Object.entries(result.data.values);

    for (const [, datesObj] of entries) {
        for (const [dateStr, value] of Object.entries(datesObj)) {
            if (isWeekend(dateStr)) continue; // Exclui sábado e domingo de todas as análises

            dailyMap[dateStr] = (dailyMap[dateStr] || 0) + value;

            if (dateStr >= b90Start && dateStr <= bEnd) {
                sum90 += value;
            }
            if (dateStr >= b30Start && dateStr <= bEnd) {
                sum30 += value;
            }
            if (dateStr >= fetchStart && dateStr <= kpiEnd) {
                sumKpi += value;
            }
            if (dateStr >= fetchStart && dateStr <= fetchEndToday) {
                sumRealtime += value;
            }
        }
    }

    const series30 = b30Dates.map(d => ({ date: d, value: dailyMap[d] || 0 }));
    const seriesCurrent = kpiDates.map(d => ({ date: d, value: dailyMap[d] || 0 }));

    return {
        sum30,
        sum90,
        sumKpi,
        sumRealtime,
        kpiAvg: Math.round(sumKpi / kpiWeekdays),
        b30Avg: Math.round(sum30 / b30Weekdays),
        b90Avg: Math.round(sum90 / b90Weekdays),
        series30,
        seriesCurrent
    };
}

// Pegar origens do login acumuladas pós-lançamento (apenas dias úteis a partir de 15/10)
async function fetchLoginOriginsToday() {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=main_login_verified&name=page_title&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEndToday}`;
    const result = await fetchMixpanel(url);

    const originsMap = {};
    let totalVolume = 0;

    if (result && result.data && result.data.values) {
        for (const [pageTitle, datesObj] of Object.entries(result.data.values)) {
            let volumeForPeriod = 0;
            for (const [dateStr, value] of Object.entries(datesObj)) {
                if (isWeekend(dateStr)) continue; // Exclui sábado e domingo
                volumeForPeriod += value;
            }
            if (volumeForPeriod > 0) {
                const safeTitle = (pageTitle && pageTitle !== 'undefined' && pageTitle !== 'null' && pageTitle.trim() !== '')
                    ? pageTitle
                    : 'Acesso Direto / Sem Título';

                originsMap[safeTitle] = (originsMap[safeTitle] || 0) + volumeForPeriod;
                totalVolume += volumeForPeriod;
            }
        }
    }

    const sortedOrigins = Object.entries(originsMap)
        .map(([tela, volume]) => ({
            tela,
            volume,
            conversao: totalVolume > 0 ? Number(((volume / totalVolume) * 100).toFixed(1)) : 0
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);

    return sortedOrigins;
}

async function extractAllData() {
    const outputPath = path.join(__dirname, 'dashboard_data.json');
    const isForced = process.argv.includes('--force');
    const isRecalcBaselines = process.argv.includes('--recalc-baselines');

    let existing = null;
    if (fs.existsSync(outputPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
            const hasCharts = existing && existing.charts && existing.charts.baseline30 && Array.isArray(existing.charts.baseline30.buscas);
            if (!isForced && !isRecalcBaselines && existing && existing.weekdaysOnly === true && hasCharts && existing.updatedAt) {
                const diffMinutes = (Date.now() - new Date(existing.updatedAt).getTime()) / 60000;
                if (diffMinutes < 50) {
                    console.log(`Última atualização ocorreu há ${diffMinutes.toFixed(1)} min (< 50 min). Ignorando execução para poupar cota do Mixpanel.`);
                    return;
                }
            }
        } catch (err) {
            console.warn("Aviso ao ler dashboard_data.json existente:", err.message);
        }
    }

    const hasBaselineCharts = existing && existing.charts && existing.charts.baseline30 && Array.isArray(existing.charts.baseline30.buscas) && existing.charts.baseline30.buscas.length > 0;
    const needBaselines = isRecalcBaselines || !existing || existing.weekdaysOnly !== true || !hasBaselineCharts;
    const queryFromDate = needBaselines ? b90Start : fetchStart;

    console.log(`Iniciando extração (Apenas Dias Úteis | kpiWeekdays=${kpiWeekdays} | queryFrom=${queryFromDate})...`);

    console.log("1/9 Buscando Buscas...");
    const buscas = await fetchEventSeries('inventory_address_search_executed', queryFromDate);

    console.log("2/9 Buscando Adição ao Carrinho...");
    const carrinho = await fetchEventSeries('inventory_item_added', queryFromDate);

    console.log("3/9 Buscando Página de Resumo...");
    const resumo = await fetchEventSeries('page_view', queryFromDate, 'page_title', 'Resumo - Aqui ads');

    console.log("4/9 Buscando Início de Checkout...");
    const checkout = await fetchEventSeries('begin_checkout', queryFromDate);

    console.log("5/9 Buscando Compras Aprovadas...");
    const compras = await fetchEventSeries('payment_approved', queryFromDate);

    console.log("6/9 Buscando Início de Login...");
    const loginStarted = await fetchEventSeries('main_login_started', queryFromDate);

    console.log("7/9 Buscando Conclusão de Login...");
    const loginCompleted = await fetchEventSeries('login', queryFromDate);

    console.log("8/9 Buscando Início de Cadastro...");
    const signupStarted = await fetchEventSeries('main_signup_started', queryFromDate);

    console.log("9/9 Buscando Conclusão de Cadastro...");
    const signupCompleted = await fetchEventSeries('main_signup_completed', queryFromDate);

    console.log("Buscando Origens do Login (Dias Úteis)...");
    const origins = await fetchLoginOriginsToday();

    const calcRate = (num, den) => den > 0 ? Number(((num / den) * 100).toFixed(1)) : 0;

    const baseline30Kpis = needBaselines ? {
        buscas: buscas.b30Avg,
        carrinho: carrinho.b30Avg,
        resumo: resumo.b30Avg,
        checkout: checkout.b30Avg,
        compras: compras.b30Avg
    } : existing.kpis.baseline30;

    const baseline90Kpis = needBaselines ? {
        buscas: buscas.b90Avg,
        carrinho: carrinho.b90Avg,
        resumo: resumo.b90Avg,
        checkout: checkout.b90Avg,
        compras: compras.b90Avg
    } : existing.kpis.baseline90;

    const baseline30Funnel = needBaselines ? {
        cadastro: calcRate(signupCompleted.sum30, signupStarted.sum30),
        login: calcRate(loginCompleted.sum30, loginStarted.sum30),
        geral: calcRate(compras.sum30, carrinho.sum30)
    } : existing.funnel.baseline30;

    const baseline90Funnel = needBaselines ? {
        cadastro: calcRate(signupCompleted.sum90, signupStarted.sum90),
        login: calcRate(loginCompleted.sum90, loginStarted.sum90),
        geral: calcRate(compras.sum90, carrinho.sum90)
    } : existing.funnel.baseline90;

    const baseline30Charts = needBaselines ? {
        buscas: buscas.series30,
        carrinho: carrinho.series30,
        resumo: resumo.series30,
        checkout: checkout.series30,
        compras: compras.series30
    } : existing.charts.baseline30;

    const data = {
        updatedAt: new Date().toISOString(),
        weekdaysOnly: true,
        kpiWeekdaysCount: kpiWeekdays,
        kpis: {
            today: {
                buscas: buscas.kpiAvg,
                carrinho: carrinho.kpiAvg,
                resumo: resumo.kpiAvg,
                checkout: checkout.kpiAvg,
                compras: compras.kpiAvg
            },
            baseline30: baseline30Kpis,
            baseline90: baseline90Kpis
        },
        charts: {
            baseline30: baseline30Charts,
            current: {
                buscas: buscas.seriesCurrent,
                carrinho: carrinho.seriesCurrent,
                resumo: resumo.seriesCurrent,
                checkout: checkout.seriesCurrent,
                compras: compras.seriesCurrent
            }
        },
        funnel: {
            today: {
                cadastro: calcRate(signupCompleted.sumRealtime, signupStarted.sumRealtime),
                login: calcRate(loginCompleted.sumRealtime, loginStarted.sumRealtime),
                geral: calcRate(compras.sumRealtime, carrinho.sumRealtime)
            },
            baseline30: baseline30Funnel,
            baseline90: baseline90Funnel
        },
        origins
    };

    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    console.log(`Extração concluída com sucesso (Apenas Dias Úteis + Séries Diárias)! Dados salvos em: ${outputPath}`);
}

extractAllData();
