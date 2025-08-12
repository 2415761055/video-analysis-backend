// api/index.js

const express = require('express');
// 引入指南P9中指定的飞书服务端SDK
const { BaseClient } = require('@lark-base-open/node-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

const app = express();
app.use(express.json()); // 启用JSON请求体解析

// --- 新增的欢迎页面路由 ---
app.get('/', (req, res) => {
  res.status(200).send('<h1>后端服务正在正常运行！</h1><p>请在您的飞书插件中进行操作。</p>');
});
// --- 新增结束 ---

// 从环境变量中安全地获取所有凭证，绝不硬编码
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN;
const FEISHU_PERSONAL_BASE_TOKEN = process.env.FEISHU_PERSONAL_BASE_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 从环境变量获取所有表格ID
const TABLE_ID_TASKS = process.env.TABLE_ID_TASKS;
const TABLE_ID_PERSONAS = process.env.TABLE_ID_PERSONAS;
const TABLE_ID_RESULTS = process.env.TABLE_ID_RESULTS;

// 遵循指南P9的示例，初始化BaseClient
const feishuClient = new BaseClient({
    appToken: FEISHU_APP_TOKEN,
    personalBaseToken: FEISHU_PERSONAL_BASE_TOKEN,
});
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * 从URL下载文件并将其转换为Gemini API所需的Base64格式
 * @param {string} url 文件的可直接下载URL
 * @returns {object} Gemini API可识别的媒体部分
 */
async function fileToGenerativePart(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`下载文件失败: ${response.statusText}`);
    }
    const buffer = await response.buffer();
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType: response.headers.get('content-type') || 'video/mp4',
        },
    };
}

// 定义主分析逻辑的API端点
app.post('/api/analyze', async (req, res) => {
    const { record_id } = req.body;
    if (!record_id) {
        return res.status(400).json({ error: '请求体中必须包含 record_id' });
    }

    try {
        // 1. 更新主任务状态为 "分析中"，提供即时反馈
        await feishuClient.base.appTableRecord.update({
            path: { table_id: TABLE_ID_TASKS, record_id: record_id },
            data: { fields: { '分析状态': '分析中' } }
        });

        // 2. 获取主任务的完整详情
        const taskRecordResponse = await feishuClient.base.appTableRecord.get({
            path: { table_id: TABLE_ID_TASKS, record_id: record_id }
        });
        const fields = taskRecordResponse.data.record.fields;
        
        const videoAttachment = fields['上传视频'];
        const videoUrl = fields['视频链接'];
        const personaRecordIds = fields['分析视角 (多选)']?.map(p => p.record_id) || [];

        if (personaRecordIds.length === 0) throw new Error('未选择任何人物画像进行分析');
        if (!videoAttachment && !videoUrl) throw new Error('未提供视频链接或上传视频文件');

        // 3. 获取视频内容，优先使用上传的附件
        let videoPart;
        if (videoAttachment && videoAttachment[0]?.file_token) {
            const fileToken = videoAttachment[0].file_token;
            const meta = await feishuClient.drive.file.meta({ params: { file_token: fileToken } });
            const downloadUrl = meta.data.download_url;
            videoPart = await fileToGenerativePart(downloadUrl);
        } else if (videoUrl) {
            videoPart = await fileToGenerativePart(videoUrl);
        } else {
            throw new Error('无法获取视频内容');
        }
        
        // 4.【核心循环】为每个人物画像进行独立分析
        for (const personaId of personaRecordIds) {
            const personaRecord = await feishuClient.base.appTableRecord.get({
                path: { table_id: TABLE_ID_PERSONAS, record_id: personaId }
            });
            const personaDesc = personaRecord.data.record.fields['AI提示词描述'];
            if (!personaDesc) continue;

            const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
            const prompt = `
              你是一名顶级的短视频内容策略师。请严格且仅仅从以下 [人物画像] 的视角，对提供的视频进行深入分析。

              [人物画像]
              ${personaDesc}

              [分析任务]
              1.  [时间点分析]: 请详细识别出视频中能引起该画像“兴趣激增”或“兴趣下降”的关键时间点，并解释原因。请至少找出3-5个关键点。输出格式为 "mm:ss - 兴趣激增/下降：具体原因..."，每个时间点占一行。
              2.  [综合评价与建议]: 请基于以上分析，为该视频给出一个总体的、详细的“综合评价与建议”，内容需要有建设性，告诉创作者如何优化才能更好地吸引这类人群。
              
              [输出要求]
              你的最终输出必须是一个单一的、可以被直接解析的JSON对象，严格遵循以下结构，不要添加任何额外的解释或Markdown标记。
              {
                "timestamp_analysis": "mm:ss - 兴趣激增：原因...\\nmm:ss - 兴趣下降：原因...",
                "overall_summary": "你的综合评价与建议..."
              }
            `;
            
            const result = await model.generateContent([prompt, videoPart]);
            const responseText = result.response.text();
            
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error(`AI未能为画像 ${personaId} 返回有效的JSON对象`);
            const analysisResult = JSON.parse(jsonMatch[0]);

            // 使用指南中的 appTableRecord.create 方法创建新记录
            await feishuClient.base.appTableRecord.create({
                data: {
                    table_id: TABLE_ID_RESULTS,
                    fields: {
                        '关联任务': [{ record_id: record_id }],
                        '分析视角': [{ record_id: personaId }],
                        '时间点分析': analysisResult.timestamp_analysis,
                        '综合评价与建议': analysisResult.overall_summary,
                    }
                }
            });
        }

        // 5. 所有分析完成后，更新主任务状态为 "已完成"
        await feishuClient.base.appTableRecord.update({
            path: { table_id: TABLE_ID_TASKS, record_id: record_id },
            data: { fields: { '分析状态': '已完成' } }
        });

        res.status(200).json({ success: true, message: '所有视角的分析均已完成' });

    } catch (error) {
        console.error('分析失败:', error);
        await feishuClient.base.appTableRecord.update({
            path: { table_id: TABLE_ID_TASKS, record_id: record_id },
            data: { fields: { '分析状态': '失败' } }
        }).catch(updateErr => console.error("更新失败状态时出错:", updateErr));

        res.status(500).json({ error: error.message });
    }
});

module.exports = app;