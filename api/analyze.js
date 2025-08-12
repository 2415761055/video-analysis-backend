// api/analyze.js (最终 Serverless 模式)

// 我们不再需要完整的 Express 框架，但仍然可以使用 cors 等中间件
const cors = require('cors');
const { BaseClient } = require('@lark-base-open/node-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

// 初始化 CORS 中间件
const corsMiddleware = cors();

// 初始化客户端 (这些可以在函数外部完成，以利用缓存)
const feishuClient = new BaseClient({ appToken: process.env.FEISHU_APP_TOKEN, personalBaseToken: process.env.FEISHU_PERSONAL_BASE_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 导出一个单一的、默认的函数，这就是我们的 Serverless Function
export default async function handler(req, res) {
  // 手动运行 CORS 中间件
  await new Promise((resolve, reject) => {
    corsMiddleware(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
  
  // 确保只处理 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // 您的所有分析逻辑，现在都在这个函数内部
  const { record_id } = req.body;
  if (!record_id) {
    return res.status(400).json({ error: '请求体中必须包含 record_id' });
  }

  try {
    // ... (您所有的 try...catch 逻辑，从 await feishuClient.base.appTableRecord.update... 开始，到 res.status(200).json(...) 结束，完全复制粘贴到这里)
    // 为了确保完整性，我将再次提供
    await feishuClient.base.appTableRecord.update({ path: { table_id: process.env.TABLE_ID_TASKS, record_id: record_id }, data: { fields: { '分析状态': '分析中' } } });
    const taskRecordResponse = await feishuClient.base.appTableRecord.get({ path: { table_id: process.env.TABLE_ID_TASKS, record_id: record_id } });
    const fields = taskRecordResponse.data.record.fields;
    const videoAttachment = fields['上传视频'];
    const videoUrl = fields['视频链接'];
    const personaRecordIds = fields['分析视角 (多选)']?.map(p => p.record_id) || [];

    if (personaRecordIds.length === 0) throw new Error('未选择任何人物画像进行分析');
    if (!videoAttachment && !videoUrl) throw new Error('未提供视频链接或上传视频文件');

    let videoPart;
    // ... (fileToGenerativePart 函数需要定义在 handler 内部或外部)
    async function fileToGenerativePart(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`下载文件失败: ${response.statusText}`);
        const buffer = await response.buffer();
        return { inlineData: { data: buffer.toString("base64"), mimeType: response.headers.get('content-type') || 'video/mp4' } };
    }

    if (videoAttachment && videoAttachment[0]?.file_token) {
        const fileToken = videoAttachment[0].file_token;
        const meta = await feishuClient.drive.file.meta({ params: { file_token: fileToken } });
        videoPart = await fileToGenerativePart(meta.data.download_url);
    } else if (videoUrl) {
        videoPart = await fileToGenerativePart(videoUrl);
    } else {
        throw new Error('无法获取视频内容');
    }
    
    for (const personaId of personaRecordIds) {
        const personaRecord = await feishuClient.base.appTableRecord.get({ path: { table_id: process.env.TABLE_ID_PERSONAS, record_id: personaId } });
        const personaDesc = personaRecord.data.record.fields['AI提示词描述'];
        if (!personaDesc) continue;

        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_IDENTIFIER || "gemini-1.5-pro-latest" });
        const prompt = `...`; // 您的 prompt
        const result = await model.generateContent([prompt, videoPart]);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`AI未能为画像 ${personaId} 返回有效的JSON对象`);
        const analysisResult = JSON.parse(jsonMatch[0]);

        await feishuClient.base.appTableRecord.create({ data: { table_id: process.env.TABLE_ID_RESULTS, fields: { '关联任务': [{ record_id: record_id }], '分析视角': [{ record_id: personaId }], '时间点分析': analysisResult.timestamp_analysis, '综合评价与建议': analysisResult.overall_summary } } });
    }

    await feishuClient.base.appTableRecord.update({ path: { table_id: process.env.TABLE_ID_TASKS, record_id: record_id }, data: { fields: { '分析状态': '已完成' } } });
    return res.status(200).json({ success: true, message: '所有视角的分析均已完成' });

  } catch (error) {
    console.error('分析失败:', error);
    await feishuClient.base.appTableRecord.update({ path: { table_id: process.env.TABLE_ID_TASKS, record_id: record_id }, data: { fields: { '分析状态': '失败' } } }).catch(updateErr => console.error("更新失败状态时出错:", updateErr));
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}