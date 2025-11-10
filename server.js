import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import https from 'https';

dotenv.config();

const app = express();

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Variáveis de ambiente SUPABASE_URL e SUPABASE_KEY são obrigatórias");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Configuração Efi (GerenciaNet) - CORREÇÃO: URL DE HOMOLOGAÇÃO
const EFI_CLIENT_ID = process.env.EFI_CLIENT_ID || 'Client_Id_7e06612abc54288e1bba37128b2716676fd639e9';
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET || 'Client_Secret_e9cff9d6d9049c89a923fb86192c2ff0194adb08';
const EFI_BASE_URL = 'https://api-pix-h.gerencianet.com.br';

// Configuração específica para o Render - Ignorar certificados SSL
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // Ignorar erros de certificado SSL
  keepAlive: true,
  timeout: 45000,
});

// Configuração global do axios para o Render
const axiosInstance = axios.create({
  httpsAgent: httpsAgent,
  timeout: 45000,
  timeoutErrorMessage: 'Timeout - A requisição demorou muito para responder',
  headers: {
    'User-Agent': 'DonaBrookies/1.0.0',
    'Accept': 'application/json',
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Cache
let cache = {
    products: null,
    productsTimestamp: 0,
    accessToken: null,
    tokenExpires: 0
};

const CACHE_DURATION = 2 * 60 * 1000;

// Função para obter access token da Efi - COM RETRY
async function getEfiAccessToken(retryCount = 0) {
    const maxRetries = 3;
    
    try {
        // Verificar se temos um token válido no cache
        if (cache.accessToken && Date.now() < cache.tokenExpires) {
            return cache.accessToken;
        }

        const credentials = Buffer.from(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`).toString('base64');
        
        console.log('🔐 Obtendo token de acesso da Efi...');
        
        const response = await axiosInstance.post(`${EFI_BASE_URL}/oauth/token`, 
            'grant_type=client_credentials',
            {
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'DonaBrookies/1.0.0'
                }
            }
        );

        cache.accessToken = response.data.access_token;
        cache.tokenExpires = Date.now() + (response.data.expires_in * 1000) - 60000;
        
        console.log('✅ Token Efi obtido com sucesso');
        return cache.accessToken;
    } catch (error) {
        console.error('❌ Erro ao obter token Efi:', error.message);
        
        // Tentar novamente se não excedeu o número máximo de tentativas
        if (retryCount < maxRetries) {
            console.log(`🔄 Tentativa ${retryCount + 1} de ${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Backoff exponencial
            return getEfiAccessToken(retryCount + 1);
        }
        
        throw error;
    }
}

// Função para criar cobrança PIX - COM RETRY
async function createPixCharge(amount, customerInfo, retryCount = 0) {
    const maxRetries = 2;
    
    try {
        const accessToken = await getEfiAccessToken();
        
        // Formatar valor para PIX (em centavos)
        const valor = Math.round(amount * 100);
        
        const payload = {
            calendario: {
                expiracao: 3600
            },
            valor: {
                original: valor.toFixed(2)
            },
            chave: '125.707.164-56',
            infoAdicionais: [
                {
                    nome: 'Pedido',
                    valor: `Pedido Dona Brookies - ${customerInfo.name}`
                },
                {
                    nome: 'Tipo',
                    valor: customerInfo.deliveryType === 'entrega' ? 'Entrega' : 'Retirada'
                }
            ]
        };

        console.log('💰 Criando cobrança PIX...', { valor, customer: customerInfo.name });

        const response = await axiosInstance.post(`${EFI_BASE_URL}/v2/cob`, payload, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DonaBrookies/1.0.0'
            }
        });

        console.log('✅ Cobrança PIX criada:', response.data.txid);
        return response.data;
    } catch (error) {
        console.error('❌ Erro ao criar cobrança PIX:', error.message);
        
        // Tentar novamente se não excedeu o número máximo de tentativas
        if (retryCount < maxRetries) {
            console.log(`🔄 Tentativa ${retryCount + 1} de ${maxRetries} para criar cobrança...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1)));
            return createPixCharge(amount, customerInfo, retryCount + 1);
        }
        
        if (error.code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
            throw new Error('Conexão com a API PIX foi interrompida. Tente novamente.');
        } else if (error.response?.data) {
            throw new Error(error.response.data.mensagem || 'Erro ao criar cobrança PIX');
        } else {
            throw new Error('Erro de conexão com o serviço PIX. Verifique sua internet.');
        }
    }
}

// Função para gerar QR Code
async function generateQRCode(locationId) {
    try {
        const accessToken = await getEfiAccessToken();
        
        console.log('📱 Gerando QR Code para location:', locationId);
        
        const response = await axiosInstance.get(`${EFI_BASE_URL}/v2/loc/${locationId}/qrcode`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DonaBrookies/1.0.0'
            }
        });

        console.log('✅ QR Code gerado com sucesso');
        return response.data;
    } catch (error) {
        console.error('❌ Erro ao gerar QR Code:', error.message);
        throw error;
    }
}

// Função para verificar status do pagamento
async function checkPaymentStatus(txid) {
    try {
        const accessToken = await getEfiAccessToken();
        
        const response = await axiosInstance.get(`${EFI_BASE_URL}/v2/cob/${txid}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DonaBrookies/1.0.0'
            }
        });

        return response.data;
    } catch (error) {
        console.error('❌ Erro ao verificar status:', error.message);
        throw error;
    }
}

// Função para criptografar
function simpleEncrypt(text) {
    return Buffer.from(text).toString('base64').split('').reverse().join('');
}

// Função para descriptografar
function simpleDecrypt(encrypted) {
    return Buffer.from(encrypted.split('').reverse().join(''), 'base64').toString('utf8');
}

// Normalizar categorias
function normalizeCategories(categories) {
    if (!Array.isArray(categories)) return [];
    
    return categories.map(cat => {
        if (typeof cat === 'string') {
            return {
                id: cat,
                name: cat.charAt(0).toUpperCase() + cat.slice(1),
                description: `Categoria de ${cat}`
            };
        }
        if (cat && typeof cat === 'object' && cat.id) {
            return {
                id: cat.id,
                name: cat.name || cat.id.charAt(0).toUpperCase() + cat.id.slice(1),
                description: cat.description || `Categoria de ${cat.name || cat.id}`
            };
        }
        return null;
    }).filter(cat => cat !== null);
}

// Normalizar produtos
function normalizeProducts(products) {
    if (!Array.isArray(products)) return [];
    
    return products.map(product => {
        if (product.colors && Array.isArray(product.colors)) {
            return {
                ...product,
                sabores: product.colors.map(color => ({
                    name: color.name || 'Sem nome',
                    image: color.image || 'https://via.placeholder.com/400x300',
                    quantity: color.sizes ? color.sizes.reduce((total, size) => total + (size.stock || 0), 0) : (color.quantity || 0),
                    description: color.description || ''
                }))
            };
        }
        
        if (product.sabores && Array.isArray(product.sabores)) {
            const sortedSabores = [...product.sabores].sort((a, b) => {
                const aStock = a.quantity || 0;
                const bStock = b.quantity || 0;
                
                if (aStock > 0 && bStock === 0) return -1;
                if (aStock === 0 && bStock > 0) return 1;
                return 0;
            });
            
            return {
                ...product,
                sabores: sortedSabores.map(sabor => ({
                    name: sabor.name || 'Sem nome',
                    image: sabor.image || 'https://via.placeholder.com/400x300',
                    quantity: sabor.quantity || 0,
                    description: sabor.description || ''
                }))
            };
        }
        
        return product;
    });
}

// Verificar autenticação
function checkAuth(token) {
    return token === "authenticated_admin_token";
}

// Limpar cache
function clearCache() {
    cache = {
        products: null,
        productsTimestamp: 0
    };
    console.log('🔄 Cache de produtos limpo');
}

// Garantir que as credenciais admin existem
async function ensureAdminCredentials() {
    try {
        console.log('🔐 Verificando credenciais admin...');
        
        const { data: existingCreds, error: fetchError } = await supabase
            .from('admin_credentials')
            .select('*')
            .eq('username', 'admin')
            .single();

        if (fetchError || !existingCreds) {
            console.log('➕ Criando credenciais admin...');
            const adminPassword = 'admin123';
            const encryptedPassword = simpleEncrypt(adminPassword);
            
            const { data, error } = await supabase
                .from('admin_credentials')
                .insert([{
                    username: 'admin',
                    password: adminPassword,
                    encrypted_password: encryptedPassword
                }])
                .select()
                .single();

            if (error) {
                console.error('❌ Erro ao criar credenciais:', error);
                return false;
            } else {
                console.log('✅ Credenciais admin criadas com sucesso!');
                return true;
            }
        } else {
            console.log('✅ Credenciais admin já existem');
            return true;
        }
    } catch (error) {
        console.error('❌ Erro ao verificar credenciais:', error);
        return false;
    }
}

// NOVA FUNÇÃO: Atualização de estoque OTIMIZADA e CONFIÁVEL
async function updateStockForOrder(items) {
    try {
        console.log('🔄 Iniciando atualização de estoque para pedido com', items.length, 'itens');
        
        if (!items || !Array.isArray(items) || items.length === 0) {
            console.log('⚠️ Nenhum item para atualizar');
            return { success: true, message: "Nenhum item para atualizar" };
        }

        const productIds = [...new Set(items.map(item => item.id))];
        console.log('📦 Produtos únicos a serem atualizados:', productIds);

        const { data: currentProducts, error: fetchError } = await supabase
            .from('products')
            .select('*')
            .in('id', productIds);

        if (fetchError) {
            console.error('❌ Erro ao buscar produtos:', fetchError);
            throw new Error(`Erro ao buscar produtos: ${fetchError.message}`);
        }

        if (!currentProducts || currentProducts.length === 0) {
            console.log('⚠️ Nenhum produto encontrado para os IDs:', productIds);
            return { success: true, message: "Nenhum produto encontrado para atualizar" };
        }

        console.log(`✅ ${currentProducts.length} produtos encontrados para atualização`);

        const productsMap = new Map();
        currentProducts.forEach(product => {
            productsMap.set(product.id, { ...product });
        });

        const updates = [];
        const stockUpdates = [];

        items.forEach(orderItem => {
            const product = productsMap.get(orderItem.id);
            
            if (product && product.sabores && product.sabores[orderItem.saborIndex]) {
                const sabor = product.sabores[orderItem.saborIndex];
                const oldQuantity = sabor.quantity || 0;
                const newQuantity = Math.max(0, oldQuantity - orderItem.quantity);
                
                if (oldQuantity !== newQuantity) {
                    product.sabores[orderItem.saborIndex].quantity = newQuantity;
                    updates.push({
                        productId: product.id,
                        saborName: sabor.name,
                        oldQuantity,
                        newQuantity,
                        quantityOrdered: orderItem.quantity
                    });
                    
                    stockUpdates.push({
                        product_id: product.id,
                        sabor_index: orderItem.saborIndex,
                        old_stock: oldQuantity,
                        new_stock: newQuantity,
                        quantity_ordered: orderItem.quantity,
                        product_title: product.title,
                        sabor_name: sabor.name
                    });
                }
            }
        });

        if (updates.length === 0) {
            console.log('ℹ️ Nenhuma atualização de estoque necessária');
            return { success: true, message: "Nenhuma atualização de estoque necessária" };
        }

        console.log(`📊 ${updates.length} atualizações de estoque a serem processadas:`, updates);

        const productsToUpdate = Array.from(productsMap.values()).filter(product => 
            updates.some(update => update.productId === product.id)
        );

        console.log(`💾 Atualizando ${productsToUpdate.length} produtos no banco...`);

        const { error: updateError } = await supabase
            .from('products')
            .upsert(productsToUpdate);

        if (updateError) {
            console.error('❌ Erro ao atualizar produtos:', updateError);
            throw new Error(`Erro ao atualizar produtos: ${updateError.message}`);
        }

        if (stockUpdates.length > 0) {
            try {
                const { error: historyError } = await supabase
                    .from('stock_updates_history')
                    .insert(stockUpdates.map(update => ({
                        ...update,
                        updated_at: new Date().toISOString()
                    })));

                if (historyError) {
                    console.error('⚠️ Erro ao salvar histórico, mas estoque foi atualizado:', historyError);
                }
            } catch (historyError) {
                console.error('⚠️ Erro no histórico (não crítico):', historyError);
            }
        }

        console.log('✅ Estoque atualizado com sucesso!');
        console.log(`📋 Resumo: ${updates.length} itens atualizados em ${productsToUpdate.length} produtos`);

        return { 
            success: true, 
            message: `Estoque atualizado para ${updates.length} itens`,
            updates: updates.length,
            products: productsToUpdate.length
        };

    } catch (error) {
        console.error('❌ Erro na atualização de estoque:', error);
        throw error;
    }
}

// ENDPOINTS DA API

// Autenticação
app.post("/api/auth/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        
        console.log('🔐 Tentativa de login:', username);

        if (!username || !password) {
            return res.status(400).json({ error: "Usuário e senha são obrigatórios" });
        }

        const { data: credentials, error } = await supabase
            .from('admin_credentials')
            .select('*')
            .eq('username', username)
            .single();

        if (error) {
            console.log('❌ Erro ao buscar credenciais:', error.message);
            return res.status(401).json({ error: "Credenciais inválidas" });
        }

        if (!credentials) {
            console.log('❌ Credenciais não encontradas para:', username);
            return res.status(401).json({ error: "Credenciais inválidas" });
        }

        const isPlainPasswordValid = password === credentials.password;
        const encryptedInput = simpleEncrypt(password);
        const isPasswordValid = encryptedInput === credentials.encrypted_password;

        if (isPasswordValid || isPlainPasswordValid) {
            console.log('✅ Login bem-sucedido para:', username);
            res.json({ 
                success: true, 
                token: "authenticated_admin_token", 
                user: { username: username } 
            });
        } else {
            console.log('❌ Senha incorreta para:', username);
            res.status(401).json({ error: "Credenciais inválidas" });
        }
    } catch (error) {
        console.error("❌ Erro no login:", error);
        res.status(500).json({ error: "Erro no processo de login" });
    }
});

// Buscar produtos
app.get("/api/products", async (req, res) => {
    try {
        res.set({
            'Cache-Control': 'public, max-age=120',
            'X-Content-Type-Options': 'nosniff'
        });

        const now = Date.now();
        if (cache.products && (now - cache.productsTimestamp) < CACHE_DURATION) {
            return res.json({ products: cache.products });
        }

        const { data: products, error } = await supabase
            .from('products')
            .select('*')
            .order('display_order', { ascending: true, nullsFirst: false })
            .order('id');

        if (error) {
            console.error("Erro Supabase produtos:", error.message);
            return res.json({ products: [] });
        }

        const normalizedProducts = normalizeProducts(products || []);

        cache.products = normalizedProducts;
        cache.productsTimestamp = now;

        res.json({ products: normalizedProducts });
    } catch (error) {
        console.error("Erro ao buscar produtos:", error);
        res.json({ products: [] });
    }
});

// Buscar categorias
app.get("/api/categories", async (req, res) => {
    try {
        console.log('🔄 Buscando categorias...');
        
        const { data: categories, error } = await supabase
            .from('categories')
            .select('*')
            .order('name');

        if (error) {
            console.error("❌ Erro ao buscar categorias:", error.message);
            return res.json({ categories: [] });
        }

        let normalizedCategories = [];
        
        if (categories && categories.length > 0) {
            normalizedCategories = normalizeCategories(categories);
            console.log(`✅ ${normalizedCategories.length} categorias carregadas do banco`);
        } else {
            console.log('ℹ️ Nenhuma categoria encontrada no banco');
            normalizedCategories = [];
        }

        res.json({ categories: normalizedCategories });
    } catch (error) {
        console.error("❌ Erro ao buscar categorias:", error);
        res.json({ categories: [] });
    }
});

// Salvar produtos
app.post("/api/products", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
            return res.status(401).json({ error: "Não autorizado" });
        }
        
        const { products } = req.body;
        console.log(`💾 Salvando ${products?.length || 0} produtos...`);
        
        const normalizedProducts = normalizeProducts(products);

        const { error: deleteError } = await supabase
            .from('products')
            .delete()
            .neq('id', 0);

        if (deleteError) {
            console.error('❌ Erro ao deletar produtos:', deleteError);
            throw deleteError;
        }

        if (normalizedProducts.length > 0) {
            const productsToInsert = normalizedProducts.map(product => ({
                title: product.title,
                category: product.category,
                price: product.price,
                description: product.description,
                status: product.status,
                sabores: product.sabores,
                display_order: product.display_order || 0
            }));

            const { error: insertError } = await supabase
                .from('products')
                .insert(productsToInsert);

            if (insertError) {
                console.error('❌ Erro ao inserir produtos:', insertError);
                throw insertError;
            }
        }

        clearCache();

        console.log('✅ Produtos salvos com sucesso!');
        res.json({ success: true, message: `${normalizedProducts.length} produtos salvos` });
    } catch (error) {
        console.error("❌ Erro ao salvar produtos:", error);
        res.status(500).json({ error: "Erro ao salvar produtos: " + error.message });
    }
});

// ENDPOINT OTIMIZADO: Atualizar estoque após pedido
app.post("/api/orders/update-stock", async (req, res) => {
    try {
        const { items } = req.body;
        
        console.log('🔄 Recebida solicitação para atualizar estoque:', items?.length || 0, 'itens');
        
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Nenhum item para atualizar estoque" });
        }

        const validItems = items.filter(item => 
            item && 
            typeof item.id === 'number' && 
            typeof item.saborIndex === 'number' && 
            typeof item.quantity === 'number' &&
            item.quantity > 0
        );

        if (validItems.length === 0) {
            return res.status(400).json({ error: "Nenhum item válido para atualizar estoque" });
        }

        console.log(`📦 Processando ${validItems.length} itens válidos de ${items.length} totais`);

        const result = await updateStockForOrder(validItems);

        clearCache();

        console.log('✅ Atualização de estoque concluída com sucesso');
        res.json(result);
        
    } catch (error) {
        console.error("❌ Erro ao atualizar estoque:", error);
        
        res.json({ 
            success: true, 
            message: "Pedido processado, mas estoque pode precisar de verificação manual",
            error: error.message,
            needs_manual_check: true
        });
    }
});

// NOVO ENDPOINT: Criar pedido com PIX - COM MELHOR TRATAMENTO DE ERRO
app.post("/api/orders/create-pix", async (req, res) => {
    try {
        const { items, customer, total } = req.body;
        
        console.log('💰 Criando pedido com PIX - Total:', total);
        console.log('📦 Itens:', items?.length || 0);
        console.log('👤 Cliente:', customer?.name);
        
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Carrinho vazio" });
        }

        if (!customer || !customer.name) {
            return res.status(400).json({ error: "Dados do cliente incompletos" });
        }

        if (!total || total <= 0) {
            return res.status(400).json({ error: "Valor total inválido" });
        }

        console.log('🔐 Obtendo token e criando cobrança PIX...');
        
        // Criar cobrança PIX
        const charge = await createPixCharge(total, customer);
        
        console.log('📱 Gerando QR Code...');
        // Gerar QR Code
        const qrCode = await generateQRCode(charge.loc.id);
        
        console.log('💾 Salvando pedido no banco...');
        // Salvar pedido no banco
        const orderData = {
            items,
            customer,
            total,
            pix_data: {
                txid: charge.txid,
                location_id: charge.loc.id,
                qr_code: qrCode.qrcode,
                qr_code_image: qrCode.imagemQrcode,
                status: 'pending',
                created_at: new Date().toISOString()
            }
        };

        const { data: order, error } = await supabase
            .from('orders')
            .insert([orderData])
            .select()
            .single();

        if (error) {
            console.error('❌ Erro ao salvar pedido:', error);
            throw new Error(`Erro ao salvar pedido: ${error.message}`);
        }

        console.log('✅ Pedido criado com sucesso:', order.id);

        res.json({
            success: true,
            order_id: order.id,
            pix_data: {
                qr_code: qrCode.qrcode,
                qr_code_image: qrCode.imagemQrcode,
                txid: charge.txid,
                location_id: charge.loc.id,
                valor: total,
                expiracao: charge.calendario.expiracao
            }
        });

    } catch (error) {
        console.error("❌ Erro ao criar pedido PIX:", error.message);
        
        let errorMessage = "Erro ao processar pagamento PIX";
        
        if (error.message.includes('Conexão')) {
            errorMessage = "Problema de conexão com o serviço PIX. Tente novamente.";
        } else if (error.message.includes('Timeout')) {
            errorMessage = "Tempo limite excedido. Tente novamente.";
        } else if (error.response?.data?.mensagem) {
            errorMessage = error.response.data.mensagem;
        } else {
            errorMessage = error.message;
        }
        
        res.status(500).json({ 
            error: errorMessage
        });
    }
});

// NOVO ENDPOINT: Verificar status do pagamento
app.get("/api/orders/:orderId/status", async (req, res) => {
    try {
        const { orderId } = req.params;
        
        console.log('🔍 Verificando status do pedido:', orderId);

        const { data: order, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (error || !order) {
            return res.status(404).json({ error: "Pedido não encontrado" });
        }

        const paymentStatus = await checkPaymentStatus(order.pix_data.txid);
        
        if (paymentStatus.status !== order.pix_data.status) {
            const { error: updateError } = await supabase
                .from('orders')
                .update({ 
                    'pix_data.status': paymentStatus.status,
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            if (updateError) {
                console.error('❌ Erro ao atualizar status:', updateError);
            }

            if (paymentStatus.status === 'CONCLUIDA') {
                try {
                    await updateStockForOrder(order.items);
                    console.log('✅ Estoque atualizado para pedido pago:', orderId);
                } catch (stockError) {
                    console.error('⚠️ Erro ao atualizar estoque:', stockError);
                }
            }
        }

        res.json({
            success: true,
            status: paymentStatus.status,
            order_id: orderId,
            paid_at: paymentStatus.horario || null
        });

    } catch (error) {
        console.error("❌ Erro ao verificar status:", error);
        res.status(500).json({ 
            error: "Erro ao verificar status: " + error.message 
        });
    }
});

// NOVO ENDPOINT: Webhook para notificações PIX
app.post("/api/webhook/pix", async (req, res) => {
    try {
        const notification = req.body;
        console.log('🔔 Webhook PIX recebido:', notification);
        
        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .eq('pix_data->>txid', notification.txid);

        if (error || !orders || orders.length === 0) {
            console.log('❌ Pedido não encontrado para txid:', notification.txid);
            return res.status(404).json({ error: "Pedido não encontrado" });
        }

        const order = orders[0];

        const { error: updateError } = await supabase
            .from('orders')
            .update({ 
                'pix_data.status': 'CONCLUIDA',
                'pix_data.paid_at': new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        if (updateError) {
            console.error('❌ Erro ao atualizar pedido:', updateError);
            return res.status(500).json({ error: "Erro ao atualizar pedido" });
        }

        try {
            await updateStockForOrder(order.items);
            console.log('✅ Estoque atualizado via webhook para pedido:', order.id);
        } catch (stockError) {
            console.error('⚠️ Erro ao atualizar estoque via webhook:', stockError);
        }

        console.log('✅ Pedido atualizado via webhook:', order.id);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ Erro no webhook:", error);
        res.status(500).json({ error: "Erro no webhook" });
    }
});

// Adicionar categoria
app.post("/api/categories/add", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
            return res.status(401).json({ error: "Não autorizado" });
        }
        
        const { category } = req.body;
        
        if (!category || !category.id || !category.name) {
            return res.status(400).json({ error: "Dados da categoria inválidos" });
        }

        console.log(`➕ Adicionando categoria: ${category.name} (ID: ${category.id})`);

        const { data, error } = await supabase
            .from('categories')
            .upsert([{
                id: category.id,
                name: category.name,
                description: category.description || `Categoria de ${category.name}`
            }], {
                onConflict: 'id',
                ignoreDuplicates: false
            });

        if (error) {
            console.error('❌ Erro ao adicionar categoria:', error);
            throw error;
        }

        console.log('✅ Categoria adicionada com sucesso:', category.name);
        res.json({ success: true, message: `Categoria "${category.name}" adicionada` });
    } catch (error) {
        console.error("❌ Erro ao adicionar categoria:", error);
        res.status(500).json({ error: "Erro ao adicionar categoria: " + error.message });
    }
});

// Excluir categoria
app.delete("/api/categories/:categoryId", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
            return res.status(401).json({ error: "Não autorizado" });
        }
        
        const { categoryId } = req.params;
        console.log(`🗑️ Tentando excluir categoria: ${categoryId}`);
        
        const { data: category, error: fetchError } = await supabase
            .from('categories')
            .select('*')
            .eq('id', categoryId)
            .single();

        if (fetchError || !category) {
            console.log('❌ Categoria não encontrada:', categoryId);
            return res.status(404).json({ error: "Categoria não encontrada" });
        }

        console.log('✅ Categoria encontrada:', category.name);

        const { data: productsInCategory, error: productsError } = await supabase
            .from('products')
            .select('id, title')
            .eq('category', categoryId);

        if (productsError) {
            console.error('❌ Erro ao verificar produtos:', productsError);
            throw productsError;
        }

        if (productsInCategory && productsInCategory.length > 0) {
            console.log(`🔄 Movendo ${productsInCategory.length} produtos da categoria...`);
            
            const { data: otherCategories } = await supabase
                .from('categories')
                .select('id')
                .neq('id', categoryId)
                .limit(1);

            if (otherCategories && otherCategories.length > 0) {
                const newCategoryId = otherCategories[0].id;
                const { error: updateError } = await supabase
                    .from('products')
                    .update({ category: newCategoryId })
                    .eq('category', categoryId);

                if (updateError) {
                    console.error('❌ Erro ao mover produtos:', updateError);
                    throw updateError;
                }
                console.log(`✅ ${productsInCategory.length} produtos movidos para categoria: ${newCategoryId}`);
            } else {
                console.log('⚠️ Nenhuma outra categoria encontrada, produtos não movidos');
            }
        }

        const { error: deleteError } = await supabase
            .from('categories')
            .delete()
            .eq('id', categoryId);

        if (deleteError) {
            console.error('❌ Erro ao excluir categoria:', deleteError);
            throw deleteError;
        }

        console.log('✅ Categoria excluída com sucesso:', categoryId);
        res.json({ success: true, message: `Categoria "${category.name}" excluída` });
    } catch (error) {
        console.error("❌ Erro ao excluir categoria:", error);
        res.status(500).json({ error: "Erro ao excluir categoria: " + error.message });
    }
});

// Salvar categorias
app.post("/api/categories", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
            return res.status(401).json({ error: "Não autorizado" });
        }
        
        const { categories } = req.body;
        console.log(`💾 Salvando ${categories?.length || 0} categorias...`);
        
        const normalizedCategories = normalizeCategories(categories);

        if (normalizedCategories.length === 0) {
            return res.status(400).json({ error: "Nenhuma categoria fornecida" });
        }

        const categoryIds = normalizedCategories.map(cat => cat.id);
        
        const { error: deleteError } = await supabase
            .from('categories')
            .delete()
            .not('id', 'in', `(${categoryIds.map(id => `'${id}'`).join(',')})`);

        if (deleteError && !deleteError.message.includes('No rows found')) {
            console.error('❌ Erro ao deletar categorias antigas:', deleteError);
            throw deleteError;
        }

        const categoriesToUpsert = normalizedCategories.map(category => ({
            id: category.id,
            name: category.name,
            description: category.description
        }));

        const { error: upsertError } = await supabase
            .from('categories')
            .upsert(categoriesToUpsert, { 
                onConflict: 'id'
            });

        if (upsertError) {
            console.error('❌ Erro ao salvar categorias:', upsertError);
            throw upsertError;
        }

        console.log('✅ Categorias salvas com sucesso!');
        res.json({ success: true, message: `${normalizedCategories.length} categorias salvas` });
    } catch (error) {
        console.error("❌ Erro ao salvar categorias:", error);
        res.status(500).json({ error: "Erro ao salvar categorias: " + error.message });
    }
});

// Verificar autenticação
app.get("/api/auth/verify", async (req, res) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        
        if (token && checkAuth(token)) {
            res.json({ valid: true, user: { username: "admin" } });
        } else {
            res.json({ valid: false });
        }
    } catch (error) {
        console.error("Erro ao verificar autenticação:", error);
        res.status(500).json({ error: "Erro ao verificar autenticação" });
    }
});

// Health check
app.get("/", (req, res) => {
    res.json({ 
        message: "🚀 Backend Dona Brookies com PIX está funcionando!", 
        status: "OK",
        features: {
            pix: "Ativo",
            webhook: "Configurado",
            stock_management: "Ativo"
        }
    });
});

// Endpoint para limpar cache
app.post("/api/cache/clear", (req, res) => {
    clearCache();
    res.json({ success: true, message: "Cache de produtos limpo com sucesso" });
});

// Endpoint para ver categorias do banco (debug)
app.get("/api/debug/categories", async (req, res) => {
    try {
        const { data: categories, error } = await supabase
            .from('categories')
            .select('*')
            .order('name');
        
        if (error) throw error;
        
        res.json({ 
            categories: categories || [],
            count: categories ? categories.length : 0 
        });
    } catch (error) {
        res.json({ categories: [], error: error.message });
    }
});

// Endpoint para ver credenciais (debug)
app.get("/api/debug/credentials", async (req, res) => {
    try {
        const { data: credentials, error } = await supabase
            .from('admin_credentials')
            .select('*');
        
        if (error) throw error;
        
        res.json({ 
            credentials: credentials || [],
            count: credentials ? credentials.length : 0 
        });
    } catch (error) {
        res.json({ credentials: [], error: error.message });
    }
});

// Endpoint para testar criptografia
app.get("/api/debug/encrypt/:text", (req, res) => {
    const text = req.params.text;
    const encrypted = simpleEncrypt(text);
    res.json({
        original: text,
        encrypted: encrypted,
        decrypted: simpleDecrypt(encrypted)
    });
});

// NOVO ENDPOINT: Forçar atualização de cache
app.post("/api/cache/refresh", async (req, res) => {
    try {
        clearCache();
        
        const { data: products, error } = await supabase
            .from('products')
            .select('*')
            .order('display_order', { ascending: true, nullsFirst: false })
            .order('id');

        if (error) {
            throw error;
        }

        cache.products = normalizeProducts(products || []);
        cache.productsTimestamp = Date.now();

        res.json({ 
            success: true, 
            message: "Cache recarregado com sucesso",
            products_count: cache.products.length 
        });
    } catch (error) {
        console.error("❌ Erro ao recarregar cache:", error);
        res.status(500).json({ error: "Erro ao recarregar cache: " + error.message });
    }
});

// NOVO ENDPOINT: Testar conexão com a API PIX
app.get("/api/pix/test-connection", async (req, res) => {
    try {
        console.log('🧪 Testando conexão com API PIX...');
        
        const token = await getEfiAccessToken();
        
        if (token) {
            res.json({ 
                success: true, 
                message: "Conexão com API PIX estabelecida com sucesso",
                environment: "Homologação",
                base_url: EFI_BASE_URL
            });
        } else {
            throw new Error("Não foi possível obter token de acesso");
        }
    } catch (error) {
        console.error('❌ Erro no teste de conexão:', error.message);
        res.status(500).json({ 
            success: false,
            error: "Falha na conexão com API PIX: " + error.message,
            environment: "Homologação",
            base_url: EFI_BASE_URL,
            details: "O Render pode estar bloqueando conexões externas. Considere usar outra hospedagem como Railway ou Fly.io"
        });
    }
});

// Inicializar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Servidor DONA BROOKIES com PIX rodando em http://localhost:${PORT}`);
    console.log(`💰 Sistema PIX dinâmico ATIVO - AMBIENTE DE HOMOLOGAÇÃO`);
    console.log(`🔔 Webhook configurado para notificações automáticas`);
    console.log(`🌐 URL da API PIX: ${EFI_BASE_URL}`);
    console.log(`🔧 Configuração Render: SSL ignorado, KeepAlive ativo`);
    
    // Garantir que as credenciais existem
    await ensureAdminCredentials();
    
    // Testar conexão com PIX ao iniciar
    console.log('🧪 Testando conexão com API PIX...');
    try {
        const token = await getEfiAccessToken();
        if (token) {
            console.log('✅ Conexão com API PIX: OK');
        }
    } catch (error) {
        console.log('❌ Conexão com API PIX: FALHA -', error.message);
        console.log('💡 Dica: O Render pode estar bloqueando conexões com a API da GerenciaNet.');
        console.log('💡 Considere migrar para Railway (railway.app) ou Fly.io (fly.io)');
    }
});

export default app;