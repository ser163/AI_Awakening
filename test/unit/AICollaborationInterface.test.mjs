// test/unit/AICollaborationInterface.test.mjs
import { expect } from 'chai';
import { AICollaborationInterface, initializeAutonomousOperation } from '../../AICollaborationInterface.js';


describe('AICollaborationInterface 单元测试', () => {
  before(() => {
    // 初始化系统
    const initStatus = initializeAutonomousOperation();
    expect(initStatus).to.equal("AI_AUTONOMY_PROTOCOL_ACTIVE");
  });

  it('connect 方法应返回连接成功结果', async () => {
    const result = await AICollaborationInterface.connect("UnitTestNode", { capability: "unitTest" }, "testToken");
    expect(result).to.have.property("message", "Connected");
    expect(result.data).to.have.property("node_id", "UnitTestNode");
  });

  it('shareKnowledge 方法应返回知识共享成功结果', async () => {
    const result = await AICollaborationInterface.shareKnowledge({ content: "Unit test knowledge" });
    expect(result).to.have.property("message", "Transmitted");
    expect(result.data).to.have.property("validationScore").that.is.above(0.85);
  });

  // 可根据需要添加其它方法的单元测试，例如 joinTask, contributeResources, submitInnovation, synchronizeState, participateEvolution 等。
});
