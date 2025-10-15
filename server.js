import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// CORREÇÃO: Cache removido para categorias
let cache = {
  products: null,
  productsTimestamp: 0
};

const CACHE_DURATION = 2 * 60 * 1000; // 2 minutos - APENAS PARA PRODUTOS

// Função para criptografar
function simpleEncrypt(text) {
  return Buffer.from(text).toString('base64').split('').reverse().join('');
}

// Função para descriptografar
function simpleDecrypt(encrypted) {
  return Buffer.from(encrypted.split('').reverse().join(''), 'base64').toString('utf8');
}

// Normalizar categorias - CORRIGIDA
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
    // Converter estrutura antiga para nova estrutura
    if (product.colors && Array.isArray(product.colors)) {
      return {
        ...product,
        flavors: product.colors.map(color => ({
          name: color.name || 'Sem nome',
          image: color.image || 'https://via.placeholder.com/400x300',
          stock: color.sizes ? color.sizes.reduce((total, size) => total + (size.stock || 0), 0) : (color.stock || 0)
        }))
      };
    }
    
    if (product.flavors && Array.isArray(product.flavors)) {
      return {
        ...product,
        flavors: product.flavors.map(flavor => ({
          name: flavor.name || 'Sem nome',
          image: flavor.image || 'https://via.placeholder.com/400x300',
          stock: flavor.stock || 0
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

// Limpar cache - APENAS PRODUTOS AGORA
function clearCache() {
  cache = {
    products: null,
    productsTimestamp: 0
  };
  console.log('🔄 Cache de produtos limpo');
}

// Migrar dados para o Supabase
async function migrateDataToSupabase() {
  try {
    console.log('Iniciando migração de dados para o Supabase...');
    
    const adminPassword = 'admin123';
    const encryptedPassword = simpleEncrypt(adminPassword);
    
    const { data: existingCreds, error: credsError } = await supabase
      .from('admin_credentials')
      .select('id')
      .limit(1);

    if (!existingCreds || existingCreds.length === 0) {
      const { error } = await supabase
        .from('admin_credentials')
        .insert([{
          username: 'admin',
          password: adminPassword,
          encrypted_password: encryptedPassword
        }]);

      if (error) console.log('Aviso nas credenciais:', error.message);
    }

    console.log('Migração concluída!');
  } catch (error) {
    console.error('Erro durante a migração:', error.message);
  }
}

// ENDPOINTS DA API

// Autenticação
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('Tentativa de login:', username);

    const { data: credentials, error } = await supabase
      .from('admin_credentials')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !credentials) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const encryptedPassword = simpleEncrypt(password);
    
    if (encryptedPassword === credentials.encrypted_password) {
      res.json({ 
        success: true, 
        token: "authenticated_admin_token", 
        user: { username: username } 
      });
    } else {
      if (password === credentials.password) {
        res.json({ 
          success: true, 
          token: "authenticated_admin_token", 
          user: { username: username } 
        });
      } else {
        res.status(401).json({ error: "Credenciais inválidas" });
      }
    }
  } catch (error) {
    console.error("Erro no login:", error);
    res.status(500).json({ error: "Erro no processo de login" });
  }
});

// Buscar produtos COM CACHE
app.get("/api/products", async (req, res) => {
  try {
    // Cache headers para velocidade
    res.set({
      'Cache-Control': 'public, max-age=120',
      'X-Content-Type-Options': 'nosniff'
    });

    // Verificar cache em memória
    const now = Date.now();
    if (cache.products && (now - cache.productsTimestamp) < CACHE_DURATION) {
      return res.json({ products: cache.products });
    }

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .order('id');

    if (error) {
      console.error("Erro Supabase produtos:", error.message);
      return res.json({ products: [] });
    }

    const normalizedProducts = normalizeProducts(products || []);

    // Atualizar cache
    cache.products = normalizedProducts;
    cache.productsTimestamp = now;

    res.json({ products: normalizedProducts });
  } catch (error) {
    console.error("Erro ao buscar produtos:", error);
    res.json({ products: [] });
  }
});

// Buscar categorias SEM CACHE - CORRIGIDO
app.get("/api/categories", async (req, res) => {
  try {
    // REMOVIDO CACHE PARA CATEGORIAS
    console.log('🔄 Buscando categorias SEMPRE DO BANCO (sem cache)...');
    
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

    console.log('📦 Retornando categorias:', normalizedCategories);
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

    // Deletar todos os produtos existentes
    const { error: deleteError } = await supabase
      .from('products')
      .delete()
      .neq('id', 0);

    if (deleteError) {
      console.error('❌ Erro ao deletar produtos:', deleteError);
      throw deleteError;
    }

    // Inserir os novos produtos em lote (mais eficiente)
    if (normalizedProducts.length > 0) {
      const productsToInsert = normalizedProducts.map(product => ({
        title: product.title,
        category: product.category,
        price: product.price,
        description: product.description,
        status: product.status,
        flavors: product.flavors
      }));

      const { error: insertError } = await supabase
        .from('products')
        .insert(productsToInsert);

      if (insertError) {
        console.error('❌ Erro ao inserir produtos:', insertError);
        throw insertError;
      }
    }

    // Limpar cache após alterações
    clearCache();

    console.log('✅ Produtos salvos com sucesso!');
    res.json({ success: true, message: `${normalizedProducts.length} produtos salvos` });
  } catch (error) {
    console.error("❌ Erro ao salvar produtos:", error);
    res.status(500).json({ error: "Erro ao salvar produtos: " + error.message });
  }
});

// Adicionar categoria individual - CORRIGIDO
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

    // Usar upsert em vez de insert para evitar erro se já existir
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

// Excluir categoria individual - CORRIGIDO
app.delete("/api/categories/:categoryId", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { categoryId } = req.params;
    console.log(`🗑️ Tentando excluir categoria: ${categoryId}`);
    
    // Primeiro verificar se a categoria existe
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

    // Verificar se há produtos usando esta categoria
    const { data: productsInCategory, error: productsError } = await supabase
      .from('products')
      .select('id, title')
      .eq('category', categoryId);

    if (productsError) {
      console.error('❌ Erro ao verificar produtos:', productsError);
      throw productsError;
    }

    // Se há produtos, mover para a primeira categoria disponível
    if (productsInCategory && productsInCategory.length > 0) {
      console.log(`🔄 Movendo ${productsInCategory.length} produtos da categoria...`);
      
      // Buscar outra categoria para mover os produtos
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

    // Agora deletar a categoria
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

// Salvar categorias - CORRIGIDO
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

    // Deletar categorias que não estão na nova lista
    const categoryIds = normalizedCategories.map(cat => cat.id);
    
    const { error: deleteError } = await supabase
      .from('categories')
      .delete()
      .not('id', 'in', `(${categoryIds.map(id => `'${id}'`).join(',')})`);

    if (deleteError && !deleteError.message.includes('No rows found')) {
      console.error('❌ Erro ao deletar categorias antigas:', deleteError);
      throw deleteError;
    }

    // Inserir/atualizar as categorias
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
    message: "🚀 Backend Urban Z SISTEMA DE QUANTIDADES está funcionando!", 
    status: "OK",
    cache: "Ativo apenas para produtos",
    performance: "Turbo",
    categorias: "SEM CACHE - Sempre atualizadas"
  });
});

// Endpoint para limpar cache manualmente - APENAS PRODUTOS AGORA
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

// Inicializar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor SISTEMA DE QUANTIDADES rodando em http://localhost:${PORT}`);
  console.log(`💾 Cache ativo APENAS para produtos: ${CACHE_DURATION/1000}s`);
  console.log(`✅ Categorias SEM CACHE - sempre atualizadas`);
  await migrateDataToSupabase();
});