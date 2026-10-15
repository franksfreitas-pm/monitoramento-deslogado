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
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Configuração de Hoje (a partir de 15/10)
const todayStr = new Date().toISOString().split('T')[0];
const currentTo = todayStr < '2026-10-15' ? '2026-10-15' : todayStr;
const fetchStart = '2026-10-15';
const fetchEnd = currentTo;

// Função genérica para pegar uma métrica de "Hoje"
async function fetchMetricToday(event, property = 'time') {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=${event}&name=${property}&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEnd}`;
    const result = await fetchMixpanel(url);
    
    let totalToday = 0;
    if (!result || !result.data || !result.data.values) return totalToday;
    
    for (const [propName, datesObj] of Object.entries(result.data.values)) {
        for (const [dateStr, value] of Object.entries(datesObj)) {
            totalToday += value;
        }
    }
    return totalToday;
}

// Volume de page_view do resumo "Hoje"
async function fetchPageViewResumoToday() {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=page_view&name=page_path&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEnd}`;
    const result = await fetchMixpanel(url);
    
    let totalToday = 0;
    if (!result || !result.data || !result.data.values || !result.data.values['/resumo']) return totalToday;
    
    for (const [dateStr, value] of Object.entries(result.data.values['/resumo'])) {
        totalToday += value;
    }
    return totalToday;
}

// Pegar origens do login "Hoje" (apenas a partir do dia 15)
async function fetchLoginOriginsToday() {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=main_login_started&name=page_title&type=general&unit=day&from_date=${fetchStart}&to_date=${fetchEnd}`;
    const result = await fetchMixpanel(url);
    
    const originsMap = {};
    let totalVolume = 0;
    
    if (result && result.data && result.data.values) {
        for (const [pageTitle, datesObj] of Object.entries(result.data.values)) {
            let volumeForPeriod = 0;
            for (const [dateStr, value] of Object.entries(datesObj)) {
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
            conversao: totalVolume > 0 ? ((volume / totalVolume) * 100).toFixed(1) : 0
        }))
        .sort((a,b) => b.volume - a.volume)
        .slice(0, 10);
        
    return sortedOrigins;
}

async function extractAllData() {
    console.log("Iniciando extração otimizada: APENAS HOJE. Baselines estão fixados.");

    const data = {
        updatedAt: new Date().toISOString(),
        kpis: {
            today: {},
            baseline30: { buscas: 889, carrinho: 425, resumo: 329, checkout: 43, compras: 16 },
            baseline90: { buscas: 884, carrinho: 391, resumo: 295, checkout: 49, compras: 12 }
        },
        funnel: {
            today: {},
            baseline30: { cadastro: 30.6, login: 15.6, geral: 3.8 },
            baseline90: { cadastro: 43.9, login: 8.5, geral: 3.1 }
        },
        origins: []
    };

    console.log("Buscando Buscas Hoje...");
    data.kpis.today.buscas = await fetchMetricToday('inventory_address_search_executed');
    
    console.log("Buscando Carrinho Hoje...");
    data.kpis.today.carrinho = await fetchMetricToday('inventory_item_added');
    
    console.log("Buscando Resumo Hoje...");
    data.kpis.today.resumo = await fetchPageViewResumoToday();
    
    console.log("Buscando Checkout Hoje...");
    data.kpis.today.checkout = await fetchMetricToday('begin_checkout');
    
    console.log("Buscando Compras Hoje...");
    data.kpis.today.compras = await fetchMetricToday('payment_approved');
    
    console.log("Buscando Funis Hoje...");
    const loginStarted = await fetchMetricToday('main_login_started');
    const loginCompleted = await fetchMetricToday('main_login_completed');
    const signupStarted = await fetchMetricToday('main_signup_started');
    const signupCompleted = await fetchMetricToday('main_signup_completed');

    data.funnel.today = {
        cadastro: signupStarted > 0 ? ((signupCompleted / signupStarted) * 100).toFixed(1) : 0,
        login: loginStarted > 0 ? ((loginCompleted / loginStarted) * 100).toFixed(1) : 0,
        geral: data.kpis.today.carrinho > 0 ? ((data.kpis.today.compras / data.kpis.today.carrinho) * 100).toFixed(1) : 0
    };

    console.log("Buscando Origens Hoje...");
    data.origins = await fetchLoginOriginsToday();

    const outputPath = path.join(__dirname, 'dashboard_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    
    console.log(`Extração concluída com sucesso! Dados salvos em: ${outputPath}`);
}

extractAllData();
