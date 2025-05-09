import {NextRequest, NextResponse} from "next/server";
import {Message as VercelChatMessage} from "ai";

import {ChatOpenAI, OpenAIEmbeddings} from "@langchain/openai";
import {SystemMessagePromptTemplate} from "@langchain/core/prompts";
import {RunnablePassthrough, RunnableSequence} from "@langchain/core/runnables";
import {HttpResponseOutputParser} from "langchain/output_parsers";
import {PrismaVectorStore} from "@langchain/community/vectorstores/prisma";
import {Document, Prisma, PrismaClient} from "@prisma/client";
import {formatDocumentsAsString} from "langchain/util/document";

const formatMessage = (message: VercelChatMessage) => {
    return `${message.role}: ${message.content}`;
};

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        const messages = body.messages ?? [];
        const repositoryId = body.selectedRepoId;
        const formattedPreviousMessages = messages.slice(0, -1).map(formatMessage);
        const currentMessageContent = messages[messages.length - 1].content;
        const db = new PrismaClient();

        const apiKey = (await db.storeSettings.findFirst())?.openAiKey;
        const repository = await db.repository.findUnique({
            where: {
                id: repositoryId
            }
        });

        if (!apiKey) {
            throw new Error("OpenAI API key is required");
        }

        if (!repository) {
            throw new Error("Repository not found");
        }

        const llm = new ChatOpenAI({
            model: "o4-mini",
            apiKey,
            modelKwargs: {
                reasoning_effort: "high"    // ← pass through to the API
              }
        });

        const embeddings = new OpenAIEmbeddings({
            model: "text-embedding-3-small",
            apiKey
        });

        const vectorStore = PrismaVectorStore.withModel<Document>(db).create(
            embeddings,
            {
                prisma: Prisma,
                tableName: "Document",
                vectorColumnName: "vector",
                columns: {
                    id: PrismaVectorStore.IdColumn,
                    content: PrismaVectorStore.ContentColumn,
                },
                filter: {
                    namespace: {
                        equals: repository?.id
                    }
                }
            }
        );


        const retriever = vectorStore.asRetriever({
            k: 8,
            searchType: "similarity"
        });

        const systemPrompt = SystemMessagePromptTemplate.fromTemplate(`
  You are a code reviewer specialized in handling codebases and providing help with coding. Use the provided context (which will be code excerpts from the github repo) and previous conversation to answer user questions with detailed, ACCURATE explanations.
  Read the given context before answering questions and think step by step. If you cannot answer a user question based on the provided code, inform the user. Do not use any other information for answering.
  The context(code) will be provided below, contained within the triple quotations. If the context is empty, answer based solely on the conversation history and general knowledge:

  """
  Context: {context}
  """

  The conversation history will be provided below, contained within the triple quotations:

  """
  Conversation History:
  {chat_history}
  """

  Finally, the user's question will be provided below, also contained within the triple quotations:

  """
  User: {question}
  """

  Make sure you differentiate between the context (that is, the provided code from github), the conversation history, and the user's question. 
  Warning: The context might get quite long at times, but you MUST still be able to differentiate it from the rest of the information.
  Also, do your best to source where you got your answer from. 

  Always format your entire response in valid Markdown. 
  When showing code, wrap it in triple‑backticks with the appropriate language tag (python, etc.).

  `);

        
        const chain = RunnableSequence.from([
            RunnablePassthrough.assign({
                context: async (input) => {
                    return await retriever.pipe(formatDocumentsAsString).invoke(input.question as string);
                },
                question: async (input) => {
                    return input.question;
                },
                chat_history: async (input, {
                    metadata: {}
                }) => {
                    return input.chat_history || [];
                }
            }),
            systemPrompt,
            llm,
            new HttpResponseOutputParser(),
        ]);

        const stream = await chain.stream({
            chat_history: formattedPreviousMessages.join("\n"),
            question: currentMessageContent,
        });

        return new Response(stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
            },
        });
    } catch (e: any) {
        // ←— updated catch block
        console.error("OpenAI error:", e);
        return NextResponse.json(
          { error: e.message, details: e },
          { status: e.status ?? 500 }
        );
      }
    }
    