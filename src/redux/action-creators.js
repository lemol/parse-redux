export default {
	initializeState: function() {
		return {
			type: 'INITIALIZE_STATE',
			payload: arguments
		};
	},
	removeState: function() {
		return {
			type: 'REMOVE_STATE',
			payload: arguments
		};
	},
	setServerData: function() {
		return {
			type: 'SET_SERVER_DATA',
			payload: arguments
		};
	},
	setPendingOp: function() {
		return {
			type: 'SET_PENDING_OP',
			payload: arguments
		};
	},
	pushPendingState: function() {
		return {
			type: 'PUSH_PENDING_STATE',
			payload: arguments
		};
	},
	popPendingState: function() {
		return {
			type: 'POP_PENDING_STATE',
			payload: arguments
		};
	},
	mergeFirstPendingState: function() {
		return {
			type: 'MERGE_FIRST_PENDING_STATE',
			payload: arguments
		};
	},
	commitServerChanges: function() {
		return {
			type: 'COMMIT_SERVER_CHANGES',
			payload: arguments
		};
	},
	enqueueTask: function() {
		return {
			type: 'ENQUEUE_TASK',
			payload: arguments
		};
	},
	_clearAllState: function() {
		return {
			type: 'CLEAR_ALL_STATE',
			payload: arguments
		}
	}
}