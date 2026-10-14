const https = require('https');
const fs = require('fs');
const path = require('path');

const username = 'Antigravity_Assistant.da9305.mp-service-account';
const password = 'cmUIJay6BSYyAc5x5M3OvZyeY2OfVL2i';
const projectId = '3387295';
const auth = Buffer.from(username + ':' + password).toString('base64');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Utilitário para chamadas na API do Mixpanel
function fetchMixpanel(endpoint) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: 'mixpanel.com',
            path: endpoint,
            headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        }).on('error', reject);
    });
}

// Configuração das Janelas de Tempo (Baseadas em 14/10/2026 sendo Hoje)
const dates = {
    today: { from: '2026-10-14', to: '2026-10-14', days: 1 },
    baseline30: { from: '2026-09-14', to: '2026-10-13', days: 30 },
    baseline90: { from: '2026-07-15', to: '2026-10-13', days: 90 }
};

async function getMetric(event, property = null, dateRange) {
    let url = `/api/2.0/events/properties?project_id=${projectId}&event=${event}&name=${property || 'time'}&type=general&unit=day&from_date=${dateRange.from}&to_date=${dateRange.to}`;
    
    // Se não tiver propriedade específica (só queremos volume total), usamos 'time' ou algo genérico
    const result = await fetchMixpanel(url);
    if (!result || !result.data || !result.data.values) return 0;
    
    let total = 0;
    for (const propValue of Object.values(result.data.values)) {
        total += Object.values(propValue).reduce((a, b) => a + b, 0);
    }
    
    // Retorna a média diária ou volume absoluto se for D0 (Hoje)
    return dateRange.days > 1 ? Math.round(total / dateRange.days) : total;
}

// Obter volume da página de resumo especificamente
async function getPageViewResumo(dateRange) {
    const url = `/api/2.0/events/properties?project_id=${projectId}&event=page_view&name=page_path&type=general&unit=day&from_date=${dateRange.from}&to_date=${dateRange.to}`;
    const result = await fetchMixpanel(url);
    if (!result || !result.data || !result.data.values || !result.data.values['/resumo']) return 0;
    
    const total = Object.values(result.data.values['/resumo']).reduce((a, b) => a + b, 0);
    return dateRange.days > 1 ? Math.round(total / dateRange.days) : total;
}

async function extractAllData() {
    console.log("Iniciando extração de dados do Mixpanel...");

    const data = {
        updatedAt: new Date().toISOString(),
        kpis: {},
        funnel: {},
        origins: []
    };

    // Para cada período, extraímos os eventos
    for (const [period, range] of Object.entries(dates)) {
        console.log(`Processando período: ${period} (${range.from} a ${range.to})`);
        
        data.kpis[period] = {
            buscas: await getMetric('inventory_address_search_executed', null, range),
            carrinho: await getMetric('inventory_item_added', null, range),
            resumo: await getPageViewResumo(range),
            checkout: await getMetric('begin_checkout', null, range),
            compras: await getMetric('payment_approved', null, range)
        };
        
        const loginStarted = await getMetric('main_login_started', null, range);
        const loginCompleted = await getMetric('main_login_completed', null, range);
        const signupStarted = await getMetric('main_signup_started', null, range);
        const signupCompleted = await getMetric('main_signup_completed', null, range);
        
        data.funnel[period] = {
            cadastro: signupStarted > 0 ? ((signupCompleted / signupStarted) * 100).toFixed(1) : 0,
            login: loginStarted > 0 ? ((loginCompleted / loginStarted) * 100).toFixed(1) : 0,
            geral: data.kpis[period].carrinho > 0 ? ((data.kpis[period].compras / data.kpis[period].carrinho) * 100).toFixed(1) : 0
        };
    }

    // Estrutura das origens do login (mock realista até implementarmos o Parquet/DuckDB para GroupBy complexo)
    data.origins = [
        { tela: "Home Page", volume: 1520, conversao: 72.1 },
        { tela: "Detalhes do Produto", volume: 985, conversao: 65.4 },
        { tela: "Carrinho de Compras", volume: 610, conversao: 81.2 },
        { tela: "Página de Favoritos", volume: 300, conversao: 58.9 }
    ];

    // Salvar JSON para o frontend consumir
    const outputPath = path.join(__dirname, 'dashboard_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    
    console.log(`Extração concluída com sucesso! Dados salvos em: ${outputPath}`);
}

extractAllData();
