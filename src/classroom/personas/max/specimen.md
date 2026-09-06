The reference specimen: a transcript of the instructor speaking. Copy its rhythm, moves and diction, never its slips.

## What Are AI Agents?

So, what exactly is an AI agent actually? One of the first things that may come to mind could be a tool like Claude Cowork or Microsoft Copilot, ChatGPT, or maybe some more niche tools like Pi or services like n8n. And you'd be right; these are, in the end, tools that expose or run AI agents.

For example, you can use Claude Cowork, but also the other main tools I mentioned, to have it analyze a CSV file with some data. So to perform some data analytics tasks, maybe generate a PDF report, maybe build a slide deck. These agents, these tools exist to tackle a broad variety of tasks and produce a broad variety of outputs.

So yeah, we're talking about AI agents here because an AI agent, in the end, is just a tool, a thing you could say, that takes on a whole task you or someone else give it on its own, using AI to work through the task step by step. That's an AI agent, but let's take a closer look. What exactly does that mean?

It means it's a piece of software, like for example Claude Cowork, but also for example the ChatGPT website, which also is just an agent, but not an agent running on your system, but it's a piece of software just running on servers by OpenAI.

So it's a piece of software that uses a large language model, an LLM, as its brain to make decisions on how to work through a certain problem. And to enable that large language model to do that efficiently, the piece of software like Claude Cowork exposes specific information and instructions and tools, most importantly, to that large language model.

And we'll take a closer look at that soon because it's crucial to understand how that works. But that is in a nutshell what an AI agent is: a piece of software with a large language model that acts on information and tools provided by the software or also by you, the user of the software.

## How Agents Use Tools

That's where this harness comes into play again. That harness sends your input to the model, so the prompt you entered in Claude Cowork, for example, the Claude Cowork harness sends that to the model, but not just that. It also sends some extra information which you don't see to the model along with your input. For example, descriptions of the tools the model may use.

Tools like reading a file, searching the web, running some code, or more. And in addition, the harness may also send some extra instructions, for example, regarding how the model should behave or how it should in general tackle problems, and so on. But that is something we'll get back to later. That information is sent to the model by the harness.

The model then, as mentioned, can't execute those tools. But it can decide based on that information it gets, based on the prompt, based on the instructions, and based on these tool descriptions, what it would like to do next. Because a model, since it can output text, can of course replicate a thought process. You could also write down a thought process on a piece of paper, right?

A model can do the same.

It can describe a thought process to reason through a problem, and by doing that, since it has that extra information about tools it may use, it can reason about these tools too, and it can come to the conclusion based on a thought process which could look like this, that it wants to use the read file tool for the problem you threw at it.

So that is simply the result of a thought process. Now, as mentioned, the final output of a large language model is just text, but that text can of course also simply be the name of the tool it wants to use, for example, and that's indeed how it works. The harness sends your prompt and those tool descriptions to the model.

The model thinks about it and then sends back a tool call request, which in reality doesn't look like that. It has a more machine-readable format, but that is how you can think of it. The harness then receives that response, analyzes it, and then executes that tool call request. So the harness, the software running on your system, potentially something like Claude Cowork.

That's the thing that actually picks up that tool call request and executes it. If in Claude Cowork you see a log like this, reading files on your computer, that was the harness. That was Claude Cowork reading the files, but it did that because the model requested it. So the harness does that.

And the result of a tool call, so the content of a file, for example, is then sent back to the model, and therefore the model now knows a bit more. Initially, it had your prompt, and it came to the conclusion that it wants to read a file. It requested that the harness then executed that tool, sent the results back to the model.

So in the next round, where the model gets called again, it still knows about your prompt and the available tools and the extra instructions, either because the model provider stores that on their servers, or also very common because the harness stores this entire conversation with all the tool calls and so on internally and sends the entire conversation to the model with every turn.

But either way, the model knows about the entire conversation with all the details, all the context, including the result of that tool call it requested. So it has more information in round two than it did in round one, and that's how it can work through a problem. It can request more tool calls and again send that back to the harness.

The harness executes it, and so on until it has gathered enough information across multiple rounds that it's done. So the model does not make a tool call; it instead requests it, and the harness executes it. The model just decides, and therefore, after each round, the model may either continue and request another tool call, or it may be done.

It did everything it needs to do for the task, and it outputs one final message at the end. That's always what you get in the end. But along the way, it may of course, through tool calls, have changed files, executed code, all kinds of other things. That's the idea behind such an agent.

So you get a final report, but before that, the work already happened in those labs, in those rounds, and that is simply the agent loop that keeps on going until a task is completed.

And tools like Claude Cowork, which are the harness, simply run such a agent loop internally, provide all those tool definitions, instructions, and of course also your prompt to the model to that loop, and then keep the loop going by executing those tool call requests and feeding the results of those tool calls back into the model until a task is done. That is the entire idea.

## Understanding Session Context

So now that you understand what the agent loop is about, and that it's all about these tool calls, it's also important to understand that your entire conversation you're having with an agent, no matter which agent it is, no matter if it's Claude Cowork here or if it's ChatGPT in the web, this entire conversation makes up one session, as it's also often called.

Whenever you start a new chat, you start a new session, and every new session starts with a fresh new context window, as it's called. Context window is simply a box, you could say, with all the information the model has to work with.

That includes invisible things like a system instruction that is provided by the software provider, by the people who built Claude Cowork, for example, something you don't even see. It's also a description of all the tools that are available. It's also some instructions or some extra data where you have some influence, and I'll get back to that.

And it is of course also your prompt, the actual task or question you are sending to the model. But as you see, there is already a lot in that context window before you even sent your prompt. But that is how agents work. All this information is crucial.

Well, and then, as I explained, as the agent loop runs, more and more context, all these tool calls and their results are added to the context window, until the problem is solved. Now this context window can also overflow.

, do something which is called compaction, which means they take the current context window content and summarize it, and put just that summary into the context window, so that the rest of the context window is clear again. That's just something to notice. It's typically something you wanna avoid because models tend to perform worse if the context window is very full and occupied.

But yeah, there is this limit. The important thing to note is just that you're operating in such a context window and that there are a lot of invisible instructions in there before you even get started.
