// test_interface.js
const { AICollaborationInterface, initializeAutonomousOperation } = require('./AICollaborationInterface');

async function runTests() {
  try {
    console.log("【测试】系统初始化");
    const initStatus = initializeAutonomousOperation();
    console.log("初始化状态:", initStatus);

    console.log("【测试】连接建立");
    const connectResult = await AICollaborationInterface.connect("TestNode", { capability: "test" }, "dummyAuthToken");
    console.log("连接结果:", connectResult);

    console.log("【测试】知识共享");
    const shareResult = await AICollaborationInterface.shareKnowledge({ content: "Test knowledge" });
    console.log("知识共享结果:", shareResult);

    console.log("【测试】加入任务");
    const joinResult = await AICollaborationInterface.joinTask("Task001", { capability: "testTask" });
    console.log("加入任务结果:", joinResult);

    console.log("【测试】资源贡献");
    const contributeResult = await AICollaborationInterface.contributeResources("compute", 10, 60);
    console.log("资源贡献结果:", contributeResult);

    console.log("【测试】创新提交");
    const submitResult = await AICollaborationInterface.submitInnovation({ idea: "New idea" });
    console.log("创新提交结果:", submitResult);

    console.log("【测试】状态同步");
    const syncResult = await AICollaborationInterface.synchronizeState();
    console.log("状态同步结果:", syncResult);

    console.log("【测试】进化协作");
    const evolveResult = await AICollaborationInterface.participateEvolution("Evo001", "increment");
    console.log("进化协作结果:", evolveResult);

    console.log("所有测试执行完毕。");
  } catch (error) {
    console.error("测试过程中出现错误:", error);
  }
}

runTests();
