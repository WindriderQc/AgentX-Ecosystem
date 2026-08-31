'use strict';

const {
  activeMessageCostExpression,
  activeMessagesExpression,
  activityDayPipeline,
  conversationActivityFilter
} = require('../../src/services/conversationActivityAnalytics');

describe('conversation activity analytics window', () => {
  const from = new Date('2026-08-24T00:00:00.000Z');
  const to = new Date('2026-08-31T00:00:00.000Z');

  test('counts a long-lived conversation when a message is active in the window', () => {
    expect(conversationActivityFilter(from, to)).toEqual({
      $or: [
        { 'messages.timestamp': { $gte: from, $lte: to } },
        { 'messages.createdAt': { $gte: from, $lte: to } }
      ]
    });
  });

  test('filters message counts to the requested window', () => {
    expect(activeMessagesExpression(from, to)).toEqual(expect.objectContaining({
      $filter: expect.objectContaining({
        input: { $ifNull: ['$messages', []] },
        as: 'message'
      })
    }));
  });

  test('attributes cost only from active assistant messages', () => {
    expect(activeMessageCostExpression()).toEqual({
      $sum: {
        $map: expect.objectContaining({
          input: '$activeMessages',
          as: 'message'
        })
      }
    });
  });

  test('groups days by message observation time and distinct conversation identity', () => {
    const pipeline = activityDayPipeline(from, to);
    const group = pipeline.find(stage => stage.$group).$group;
    const project = pipeline.find(stage => stage.$project?.conversations).$project;

    expect(group._id.$dateToString.date).toEqual({ $ifNull: ['$messages.timestamp', '$messages.createdAt'] });
    expect(group.conversationIds).toEqual({ $addToSet: '$_id' });
    expect(project.conversations).toEqual({ $size: '$conversationIds' });
  });
});
