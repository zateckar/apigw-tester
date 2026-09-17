package schedule

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestReaperFiresExpiredDeadline(t *testing.T) {
	r := NewReaper()
	defer r.Stop()
	var fired atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	r.After(time.Now().Add(30*time.Millisecond), cancel)
	go func() {
		<-ctx.Done()
		fired.Add(1)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && fired.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if fired.Load() != 1 {
		t.Fatal("deadline never fired")
	}
}

func TestReaperDoneRemovesDeadline(t *testing.T) {
	r := NewReaper()
	defer r.Stop()
	var fired atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	h := r.After(time.Now().Add(20*time.Millisecond), cancel)
	h.Done()
	cancel()
	select {
	case <-ctx.Done():
		// expected: caller cancels after Done
	default:
		t.Fatal("caller cancel should make ctx done")
	}
	time.Sleep(60 * time.Millisecond)
	if fired.Load() != 0 {
		t.Fatal("removed deadline fired")
	}
}

func TestReaperStopCancelsOutstanding(t *testing.T) {
	r := NewReaper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.After(time.Now().Add(time.Hour), cancel)
	r.Stop()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel outstanding deadline")
	}
}
