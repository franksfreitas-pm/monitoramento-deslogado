const https = require('https');
const fs = require('fs');
const path = require('path');

const username = 'Antigravity_Assistant.da9305.mp-service-account';
const password = 'cmUIJay6BSYyAc5x5M3OvZyeY2OfVL2i';
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
            console.error(`Erro na requisição (tentativa ${i+1}): ${e.message}`);
            if (i === retries - 1) return null;
            // Esperar 2s antes de tentar de novo
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Configuração das Janelas de Tempo
const todayStr = new Date().toISOString().split('T')[0];
// Se hoje for antes do dia 15, travamos a consulta no dia 15 para retornar zerado e não sujar com tráfego pré-deploy.
const currentTo = todayStr < '2026-10-15' ? '2026-10-15' : todayStr;

const dateRanges = {
    today: { from: '2026-10-15', to: currentTo, days: 1 },
    baseline30: { from: '2026-09-14', to: '2026-10-13', days: 30 },
    baseline90: { from: '2026-07-15', to: '2026-10-13', days: 90 }
};

// Pega todos os dados da janela mais ampla (90 dias até hoje) para otimizar requisições
const fetchStart = '2026-07-15';
const fetchEnd = currentTo;

function isDateInRange(dateStr, rangeStr) {
    return dateStr >= dateRanges[rangeStr].from && dateStr <= dateRanges[rangeStr].to;
}

// Função genérica para pegar uma métrica de um único request em lote
async function fetchMetricBatch(event, property = 'time') {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=${event}&name=${property}&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEnd}`;
    const result = await fetchMixpanel(url);
    
    const aggregated = { today: 0, baseline30: 0, baseline90: 0 };
    
    if (!result || !result.data || !result.data.values) return aggregated;
    
    for (const [propName, datesObj] of Object.entries(result.data.values)) {
        for (const [dateStr, value] of Object.entries(datesObj)) {
            if (isDateInRange(dateStr, 'today')) aggregated.today += value;
            if (isDateInRange(dateStr, 'baseline30')) aggregated.baseline30 += value;
            if (isDateInRange(dateStr, 'baseline90')) aggregated.baseline90 += value;
        }
    }
    
    // Normalizar baselines para média diária
    aggregated.baseline30 = Math.round(aggregated.baseline30 / 30);
    aggregated.baseline90 = Math.round(aggregated.baseline90 / 90);
    
    return aggregated;
}

async function fetchPageViewResumoBatch() {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=page_view&name=page_path&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEnd}`;
    const result = await fetchMixpanel(url);
    
    const aggregated = { today: 0, baseline30: 0, baseline90: 0 };
    if (!result || !result.data || !result.data.values || !result.data.values['/resumo']) return aggregated;
    
    for (const [dateStr, value] of Object.entries(result.data.values['/resumo'])) {
        if (isDateInRange(dateStr, 'today')) aggregated.today += value;
        if (isDateInRange(dateStr, 'baseline30')) aggregated.baseline30 += value;
        if (isDateInRange(dateStr, 'baseline90')) aggregated.baseline90 += value;
    }
    
    aggregated.baseline30 = Math.round(aggregated.baseline30 / 30);
    aggregated.baseline90 = Math.round(aggregated.baseline90 / 90);
    
    return aggregated;
}

// Pegar origens do login (usando page_title em main_login_started)
async function fetchLoginOrigins() {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=main_login_started&name=page_title&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEnd}`;
    const result = await fetchMixpanel(url);
    
    const originsMap = {};
    let totalVolume = 0;
    
    if (result && result.data && result.data.values) {
        for (const [pageTitle, datesObj] of Object.entries(result.data.values)) {
            let volumeForPeriod = 0;
            for (const [dateStr, value] of Object.entries(datesObj)) {
                // Origem exibida baseada no baseline de 30 dias para ter volume representativo (ou usar 'today' quando tiver tração)
                // Vamos somar os ultimos 30 dias para o share:
                if (dateStr >= '2026-09-15' && dateStr <= currentTo) {
                    volumeForPeriod += value;
                }
            }
            if (volumeForPeriod > 0) {
                // Limpar título se vier estranho (ex: undefined, null, vazios)
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
            conversao: totalVolume > 0 ? (volume / totalVolume) * 100 : 0
        }))
        .sort((a,b) => b.volume - a.volume)
        .slice(0, 10); // top 10 origens
        
    return sortedOrigins;
}

async function extractAllData() {
    console.log("Iniciando extração otimizada de dados do Mixpanel (Lote)...");

    const data = {
        updatedAt: new Date().toISOString(),
        kpis: { today: {}, baseline30: {}, baseline90: {} },
        funnel: { today: {}, baseline30: {}, baseline90: {} },
        origins: []
    };

    // Fazer as chamadas (Apenas 9 requisições no total para a API, reduz drasticamente o rate limit)
    console.log("Buscando Buscas...");
    const buscas = await fetchMetricBatch('inventory_address_search_executed');
    console.log("Buscando Carrinho...");
    const carrinho = await fetchMetricBatch('inventory_item_added');
    console.log("Buscando Resumo...");
    const resumo = await fetchPageViewResumoBatch();
    console.log("Buscando Checkout...");
    const checkout = await fetchMetricBatch('begin_checkout');
    console.log("Buscando Compras...");
    const compras = await fetchMetricBatch('payment_approved');
    
    console.log("Buscando Funis de Login e Cadastro...");
    const loginStarted = await fetchMetricBatch('main_login_started');
    const loginCompleted = await fetchMetricBatch('main_login_completed');
    const signupStarted = await fetchMetricBatch('main_signup_started');
    const signupCompleted = await fetchMetricBatch('main_signup_completed');

    for (const period of ['today', 'baseline30', 'baseline90']) {
        data.kpis[period] = {
            buscas: buscas[period],
            carrinho: carrinho[period],
            resumo: resumo[period],
            checkout: checkout[period],
            compras: compras[period]
        };
        
        data.funnel[period] = {
            cadastro: signupStarted[period] > 0 ? ((signupCompleted[period] / signupStarted[period]) * 100).toFixed(1) : 0,
            login: loginStarted[period] > 0 ? ((loginCompleted[period] / loginStarted[period]) * 100).toFixed(1) : 0,
            geral: carrinho[period] > 0 ? ((compras[period] / carrinho[period]) * 100).toFixed(1) : 0
        };
    }

    console.log("Buscando Origens...");
    data.origins = await fetchLoginOrigins();

    const outputPath = path.join(__dirname, 'dashboard_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    
    console.log(`Extração concluída com sucesso! Dados salvos em: ${outputPath}`);
}

extractAllData();
